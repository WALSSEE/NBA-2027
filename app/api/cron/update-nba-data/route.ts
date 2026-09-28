import { NextResponse } from "next/server";
import { fetchResultsForDate } from "@/lib/scheduleFetch";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SEASON = process.env.NBA_SEASON ?? "2026-27";

// Pelattujen otteluiden tulokset + ORTG/DRTG/Pace ESPN:stä (stats.nba.com ei vastaa
// Vercelin palvelimille). Käsittelee kerralla enintään 8 päivää, joilta tulokset
// puuttuvat — aja uudelleen (Games-sivun nappi), jos jäljellä on enemmän.
export async function GET(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const supabase = getSupabaseAdmin();
  const seasonStart = `${SEASON.slice(0, 4)}-10-01`;
  const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
  const { data: missing, error } = await supabase
    .from("schedule")
    .select("id, game_id, date, home, away")
    .gte("date", seasonStart)
    .lt("date", today)
    .is("home_ortg", null)
    .order("date");
  if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  const dates = Array.from(new Set((missing ?? []).map((g: any) => g.date))).slice(0, 8);
  const log: string[] = [];
  let updated = 0;
  for (const date of dates) {
    try {
      const res = await fetchResultsForDate(date);
      for (const r of res) {
        const row = (missing ?? []).find((g: any) => g.date === r.date && g.home === r.home && g.away === r.away);
        const values = {
          home_score: r.home_score,
          away_score: r.away_score,
          home_ortg: Math.round(r.home_ortg * 10) / 10,
          home_drtg: Math.round(r.home_drtg * 10) / 10,
          home_pace: Math.round(r.pace * 10) / 10,
          away_ortg: Math.round(r.away_ortg * 10) / 10,
          away_drtg: Math.round(r.away_drtg * 10) / 10,
          away_pace: Math.round(r.pace * 10) / 10,
        };
        const q = row
          ? supabase.from("schedule").update(values).eq("id", row.id)
          : supabase.from("schedule").upsert({ game_id: `espn-${r.espnId}`, date: r.date, home: r.home, away: r.away, ...values }, { onConflict: "game_id" });
        const { error: e2 } = await q;
        if (e2) log.push(`${r.date} ${r.away} @ ${r.home}: ${e2.message}`);
        else updated++;
      }
      log.push(`${date}: ${res.length} ottelua`);
    } catch (e: any) {
      log.push(`${date}: ${e?.message ?? e}`);
    }
  }
  const remaining = new Set((missing ?? []).map((g: any) => g.date)).size - dates.length;
  return NextResponse.json({ ok: true, updated, remainingDays: Math.max(0, remaining), log });
}
