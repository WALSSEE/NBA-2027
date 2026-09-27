import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Tämä reitti PYYHKII koko players-taulun ja korvaa sen liitetyllä datalla.
// Suojattu samalla CRON_SECRET-arvolla kuin cron-reitit (Vercelissä jo
// asetettu ympäristömuuttuja) — sivu app/players/page.tsx kysyy tämän
// salasanan käyttäjältä ja lähettää sen Authorization-headerissa.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const players = body?.players;
  // mode "replace" (oletus): pyyhkii KOKO players-taulun ja korvaa sen.
  // mode "team": päivittää yhden joukkueen (body.team) liitetyt pelaajat
  // upsertilla; liitteestä puuttuvat pelaajat säilyvät, ellei niitä ole
  // nimetty body.removeNames-listassa. Käytetään EPM-sivun joukkuetuonnissa.
  // mode "merge": upsert (team,name) -avaimella, EI poista mitään. Tätä
  // käytetään "koko liiga" -tuonnissa, kun dataa liitetään useassa
  // pätkässä eri istunnoissa — vaatii players_team_name_unique-rajoitteen
  // (ks. supabase/add_players_unique_constraint.sql).
  const mode = body?.mode === "team" ? "team" : body?.mode === "merge" ? "merge" : "replace";
  const team = body?.team ? String(body.team).trim() : null;

  if (!Array.isArray(players) || players.length === 0) {
    return NextResponse.json({ error: "Ei pelaajia liitteessä (players-taulukko tyhjä tai puuttuu)." }, { status: 400 });
  }
  if (mode === "team" && !team) {
    return NextResponse.json({ error: "mode=team vaatii team-kentän." }, { status: 400 });
  }

  for (const p of players) {
    const teamOk = mode === "team" ? true : !!p.team;
    if (!teamOk || !p.name) {
      return NextResponse.json({ error: "Jokaisella pelaajalla pitää olla team ja name." }, { status: 400 });
    }
  }

  const supabase = getSupabaseAdmin();

  if (mode === "team") {
    // Joukkueen päivitys EPM-sivulta: upsert liitetyille pelaajille, EI poista
    // automaattisesti niitä joita liitteessä ei ole (esim. käsin lisätyt
    // tulokkaat, joita ei vielä ole EPM-sivulla). Poistetaan vain ne nimet,
    // jotka käyttäjä on erikseen valinnut (body.removeNames).
    const rows = players.map((p: any) => ({
      team,
      name: p.name,
      pos: p.pos ?? "",
      mpg_base: p.mpg_base ?? 0,
      oepm: p.oepm ?? 0,
      depm: p.depm ?? 0,
      active: p.active ?? true,
    }));
    const { error: upsertError } = await supabase.from("players").upsert(rows, { onConflict: "team,name" });
    if (upsertError) {
      return NextResponse.json({ error: `Tallennus epäonnistui: ${upsertError.message}` }, { status: 500 });
    }
    const removeNames: string[] = Array.isArray(body?.removeNames) ? body.removeNames.map(String) : [];
    if (removeNames.length > 0) {
      const { error: delError } = await supabase.from("players").delete().eq("team", team).in("name", removeNames);
      if (delError) {
        return NextResponse.json(
          { error: `Pelaajat päivitetty, mutta poisto epäonnistui: ${delError.message}` },
          { status: 500 }
        );
      }
    }
    return NextResponse.json({ ok: true, count: rows.length, removed: removeNames.length });
  }

  if (mode === "merge") {
    const rows = players.map((p: any) => ({
      team: p.team,
      name: p.name,
      pos: p.pos ?? "",
      mpg_base: p.mpg_base ?? 0,
      oepm: p.oepm ?? 0,
      depm: p.depm ?? 0,
      active: p.active ?? true,
    }));
    const CHUNK = 500;
    let upserted = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const { error: upsertError } = await supabase
        .from("players")
        .upsert(chunk, { onConflict: "team,name" });
      if (upsertError) {
        return NextResponse.json(
          {
            error: `Tallennus epäonnistui (${upserted}/${rows.length} tallennettu ennen virhettä): ${upsertError.message}. Onko players_team_name_unique-rajoite ajettu Supabasessa? (ks. supabase/add_players_unique_constraint.sql)`,
          },
          { status: 500 }
        );
      }
      upserted += chunk.length;
    }
    return NextResponse.json({ ok: true, count: upserted });
  }

  // mode "replace": koko roster korvataan kerralla.
  const { error: deleteError } = await supabase.from("players").delete().not("id", "is", null);
  if (deleteError) {
    return NextResponse.json({ error: `Vanhan datan poisto epäonnistui: ${deleteError.message}` }, { status: 500 });
  }

  const rows = players.map((p: any) => ({
    team: p.team,
    name: p.name,
    pos: p.pos ?? "",
    mpg_base: p.mpg_base ?? 0,
    oepm: p.oepm ?? 0,
    depm: p.depm ?? 0,
    active: p.active ?? true,
  }));

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error: insertError } = await supabase.from("players").insert(chunk);
    if (insertError) {
      return NextResponse.json(
        { error: `Tallennus epäonnistui (${inserted}/${rows.length} tallennettu ennen virhettä): ${insertError.message}` },
        { status: 500 }
      );
    }
    inserted += chunk.length;
  }

  return NextResponse.json({ ok: true, count: inserted });
}

// GET palauttaa nykyisen rosterin (esikatselua / debug-tarkoitukseen).
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("players").select("*").order("team").order("name");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ players: data ?? [] });
}
