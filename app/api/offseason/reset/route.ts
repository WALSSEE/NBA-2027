import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { planReset } from "@/lib/resetPlan";
import { PREV_SEASON } from "@/lib/prevSeason";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Aloitus alusta.
//  mode "log":  tyhjentää transaktiolokin, rosterit ennallaan.
//  mode "full": tyhjentää lokin JA palauttaa pelaajat kauden 25-26 lähtötilanteeseen
//               (ks. lib/resetPlan.ts): joukkue = kauden viimeinen joukkue,
//               minuutit = koko kauden minuutit / 82. Kesän muutos on silloin 0
//               (paitsi kesken kauden treidatuilla, joiden vaikutus on todellinen).
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const mode = body?.mode === "full" ? "full" : body?.mode === "log" ? "log" : null;
  if (!mode || body?.confirm !== "RESET") {
    return NextResponse.json({ error: "mode (log/full) ja confirm: RESET vaaditaan." }, { status: 400 });
  }
  const supabase = getSupabaseAdmin();

  // Tarkistetaan 25-26 data ennen kuin mitään poistetaan.
  const prev: any[] = [];
  if (mode === "full") {
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase
        .from("prev_season_minutes")
        .select("team, name, min_total, final_team")
        .eq("season", PREV_SEASON)
        .range(from, from + 999);
      if (error) return NextResponse.json({ error: `25-26 minuutteja ei saatu haettua: ${error.message}. Aja supabase/setup_season_baseline.sql.` }, { status: 500 });
      prev.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    if (prev.length === 0) {
      return NextResponse.json({ error: "25-26 minuutit puuttuvat — aja ensin supabase/setup_season_baseline.sql. Mitään ei muutettu." }, { status: 400 });
    }
  }

  const { error: txErr } = await supabase.from("transactions").delete().not("id", "is", null);
  if (txErr) return NextResponse.json({ error: `Lokin tyhjennys epäonnistui: ${txErr.message}` }, { status: 500 });
  if (mode === "log") return NextResponse.json({ ok: true, mode });

  const players: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("players").select("id, team, name, active, mpg_base").range(from, from + 999);
    if (error) return NextResponse.json({ error: error.message }, { status: 500 });
    players.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const { moves, deact, inserts, others } = planReset(prev, players);

  const run = async (label: string, rows: Record<string, unknown>[], insert = false) => {
    for (let i = 0; i < rows.length; i += 200) {
      const chunk = rows.slice(i, i + 200);
      const { error } = insert
        ? await supabase.from("players").insert(chunk)
        : await supabase.from("players").upsert(chunk, { onConflict: "id" });
      if (error) throw new Error(`${label} (${i}/${rows.length}): ${error.message}`);
    }
  };
  try {
    // Järjestys: ensin tuplarivit pois, sitten siirrot, lopuksi uudet.
    await run("Tuplarivien poisto", deact);
    await run("Muut pelaajat 0 min", others);
    await run("Palautus", moves);
    await run("Uudet pelaajat", inserts, true);
  } catch (e: any) {
    return NextResponse.json({ error: `Loki tyhjennetty, mutta rosterien palautus keskeytyi: ${e.message}` }, { status: 500 });
  }
  return NextResponse.json({
    ok: true,
    mode,
    restored: moves.length,
    added: inserts.map((r) => `${r.name} (${r.team})`),
    deactivatedDuplicates: deact.length,
    zeroed: others.length,
  });
}
