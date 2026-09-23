import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Treidi/siirto: pelaaja siirtyy (tai hänen minuuttinsa muuttuvat) — tämä
// laskee EPM:n oikean minuuttipainotuksen (raaka per-100-poss EPM skaalataan
// pelaajan odotetuilla minuuteilla /48) ja kirjaa muutoksen transactions-
// tauluun sekä päivittää pelaajan team/mpg_base-kentät players-tauluun.
//
// Kaava: vaikutus = raaka_epm * (minuutit / 48)
// Lähtevä joukkue saa negatiivisen deltan (vanhoilla minuuteilla),
// vastaanottava joukkue positiivisen (uusilla minuuteilla). Jos joukkue
// pysyy samana (vain minuutit muuttuvat), molemmat rivit kirjataan silti —
// nettovaikutus näkyy oikein kun joukkueen kaikki deltat summataan.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const playerId = body?.playerId ? String(body.playerId) : null;
  const newTeam = body?.newTeam ? String(body.newTeam).trim() : null;
  const newMpg = typeof body?.newMpg === "number" ? body.newMpg : null;

  if (!playerId || !newTeam || newMpg === null) {
    return NextResponse.json({ error: "playerId, newTeam ja newMpg vaaditaan." }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  const { data: player, error: playerError } = await supabase
    .from("players")
    .select("*")
    .eq("id", playerId)
    .single();

  if (playerError || !player) {
    return NextResponse.json({ error: `Pelaajaa ei löytynyt: ${playerError?.message ?? "tuntematon virhe"}` }, { status: 404 });
  }

  const oldTeam = player.team as string;
  const oldMpg = (player.mpg_base as number) ?? 0;
  const oepm = (player.oepm as number) ?? 0;
  const depm = (player.depm as number) ?? 0;

  const deltaOutO = -oepm * (oldMpg / 48);
  const deltaOutD = -depm * (oldMpg / 48);
  const deltaInO = oepm * (newMpg / 48);
  const deltaInD = depm * (newMpg / 48);

  // Sama created_at molemmille riveille, jotta ne voi tarvittaessa poistaa
  // yhdessä (ks. DELETE alla).
  const now = new Date().toISOString();
  const rows = [
    { player_name: player.name, team: oldTeam, direction: "out", delta_o: deltaOutO, delta_d: deltaOutD, created_at: now },
    { player_name: player.name, team: newTeam, direction: "in", delta_o: deltaInO, delta_d: deltaInD, created_at: now },
  ];

  const { error: insertError } = await supabase.from("transactions").insert(rows);
  if (insertError) {
    return NextResponse.json({ error: `Kirjaus epäonnistui: ${insertError.message}` }, { status: 500 });
  }

  const { error: updateError } = await supabase
    .from("players")
    .update({ team: newTeam, mpg_base: newMpg })
    .eq("id", playerId);

  if (updateError) {
    return NextResponse.json(
      { error: `Transaktio kirjattu, mutta pelaajan päivitys epäonnistui: ${updateError.message}` },
      { status: 500 }
    );
  }

  return NextResponse.json({
    ok: true,
    oldTeam,
    newTeam,
    oldMpg,
    newMpg,
    deltaOut: { o: deltaOutO, d: deltaOutD },
    deltaIn: { o: deltaInO, d: deltaInD },
  });
}

// GET palauttaa kaikki kirjatut transaktiot (uusimmat ensin).
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("transactions")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ transactions: data ?? [] });
}

// DELETE poistaa yhden transaktioparin (out+in) niiden yhteisen created_at-
// hetken perusteella — käytetään virheellisen kirjauksen kumoamiseen.
// HUOM: tämä EI palauta pelaajan team/mpg_base-kenttiä automaattisesti
// takaisin, koska emme tallenna "edellistä tilaa" — jos peruutat, korjaa
// pelaajan joukkue/minuutit tarvittaessa erikseen Pelaajat-sivulla.
export async function DELETE(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const { searchParams } = new URL(request.url);
  const createdAt = searchParams.get("created_at");
  if (!createdAt) {
    return NextResponse.json({ error: "created_at-parametri vaaditaan." }, { status: 400 });
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("transactions").delete().eq("created_at", createdAt);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
