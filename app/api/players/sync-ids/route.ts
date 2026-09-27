import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { nbaStatsFetch, resultSetToObjects } from "@/lib/nbaStats";
import { normalizePlayerName } from "@/lib/parseTransactions";
import { normalizeTeamName } from "@/lib/teamNames";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SEASON = process.env.NBA_SEASON ?? "2026-27";

// Hakee NBA:n pelaajahakemiston (playerindex) ja kirjoittaa jokaiselle
// players-taulun pelaajalle nba_id:n nimen perusteella. nba_id:llä haetaan
// pelaajakuvat NBA:n CDN:stä (Matchup-sivu). Ajetaan käsin Players-sivun
// napista aina kun rosteriin on tullut uusia pelaajia.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let index: any[];
  try {
    const url = `https://stats.nba.com/stats/playerindex?College=&Country=&DraftPick=&DraftRound=&DraftYear=&Height=&Historical=1&LeagueID=00&Season=${SEASON}&SeasonType=Regular%20Season&TeamID=0&Weight=`;
    const data = await nbaStatsFetch(url);
    const rs = data?.resultSets?.[0] ?? data?.resultSet;
    if (!rs?.headers || !rs?.rowSet) {
      return NextResponse.json(
        { error: "NBA:n vastauksen muoto oli odottamaton.", rawSample: JSON.stringify(data).slice(0, 1500) },
        { status: 502 }
      );
    }
    index = resultSetToObjects(rs);
  } catch (e: any) {
    return NextResponse.json({ error: `NBA-hakemiston haku epäonnistui: ${e?.message ?? e}` }, { status: 502 });
  }

  // nimi -> ehdokkaat (voi olla useita samannimisiä, esim. historiallisia)
  const byName = new Map<string, any[]>();
  for (const row of index) {
    const full = `${row.PLAYER_FIRST_NAME ?? ""} ${row.PLAYER_LAST_NAME ?? ""}`.trim();
    if (!full || !row.PERSON_ID) continue;
    const key = normalizePlayerName(full);
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key)!.push(row);
  }

  const supabase = getSupabaseAdmin();
  const { data: players, error } = await supabase.from("players").select("id, team, name, nba_id");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  const updates: { id: string; team: string; name: string; nba_id: number }[] = [];
  const unmatched: string[] = [];
  for (const p of players ?? []) {
    const candidates = byName.get(normalizePlayerName(p.name)) ?? [];
    if (candidates.length === 0) {
      if (!p.nba_id) unmatched.push(`${p.name} (${p.team})`);
      continue;
    }
    // Samannimisistä: ensisijaisesti sama joukkue, sitten tuorein (TO_YEAR).
    const sameTeam = candidates.find((c) => c.TEAM_ABBREVIATION && normalizeTeamName(c.TEAM_ABBREVIATION) === p.team);
    const best =
      sameTeam ??
      [...candidates].sort((a, b) => Number(b.TO_YEAR ?? 0) - Number(a.TO_YEAR ?? 0))[0];
    const id = Number(best.PERSON_ID);
    if (id && id !== Number(p.nba_id)) updates.push({ id: p.id, team: p.team, name: p.name, nba_id: id });
  }

  for (let i = 0; i < updates.length; i += 500) {
    const { error: upErr } = await supabase.from("players").upsert(updates.slice(i, i + 500), { onConflict: "id" });
    if (upErr) {
      return NextResponse.json({ error: `Tallennus epäonnistui: ${upErr.message}` }, { status: 500 });
    }
  }

  return NextResponse.json({ ok: true, indexSize: index.length, updated: updates.length, unmatched });
}
