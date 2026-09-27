import { getSupabaseAdmin } from "./supabase";
import { PREV_SEASON } from "./prevSeason";

// Korvaa viime kauden rivit prev_season_minutes-taulussa.
export async function replaceSeasonRows(rows: any[]): Promise<{ count: number; error?: string }> {
  const supabase = getSupabaseAdmin();
  const { error: delErr } = await supabase.from("prev_season_minutes").delete().eq("season", PREV_SEASON);
  if (delErr) return { count: 0, error: `${delErr.message}. Onko supabase/add_prev_season_minutes.sql ajettu?` };
  const clean = rows
    .filter((r) => r?.team && r?.name)
    .map((r) => ({
      season: PREV_SEASON,
      team: String(r.team),
      name: String(r.name),
      nba_id: r.nba_id ? Number(r.nba_id) : null,
      gp: Math.round(Number(r.gp) || 0),
      min_total: Number(r.min_total) || 0,
    }));
  let count = 0;
  for (let i = 0; i < clean.length; i += 500) {
    const { error } = await supabase.from("prev_season_minutes").insert(clean.slice(i, i + 500));
    if (error) return { count, error: error.message };
    count += Math.min(500, clean.length - i);
  }
  return { count };
}
