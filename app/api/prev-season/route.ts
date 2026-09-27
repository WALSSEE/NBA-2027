import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { PREV_SEASON } from "@/lib/prevSeason";
import { replaceSeasonRows } from "@/lib/prevSeasonDb";

export const dynamic = "force-dynamic";

// GET: viime kauden minuutit (per pelaaja per joukkue).
export async function GET() {
  const supabase = getSupabaseAdmin();
  const all: any[] = [];
  // Supabase palauttaa oletuksena max 1000 riviä kerralla.
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("prev_season_minutes")
      .select("team, name, nba_id, gp, min_total")
      .eq("season", PREV_SEASON)
      .order("team")
      .order("name")
      .range(from, from + 999);
    if (error) {
      return NextResponse.json(
        { error: `${error.message}. Onko supabase/add_prev_season_minutes.sql ajettu?`, rows: [] },
        { status: 500 }
      );
    }
    all.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return NextResponse.json({ season: PREV_SEASON, rows: all });
}

// POST: korvaa kauden kaikki rivit liitetyillä. body: { rows: [{team, name, nba_id?, gp, min_total}] }
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const rows = Array.isArray(body?.rows) ? body.rows : null;
  if (!rows || rows.length === 0) {
    return NextResponse.json({ error: "rows puuttuu tai on tyhjä." }, { status: 400 });
  }
  const res = await replaceSeasonRows(rows);
  if (res.error) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ ok: true, count: res.count });
}
