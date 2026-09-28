import { NextResponse } from "next/server";
import { fetchScheduleCdn, fetchScheduleEspn, type SchedRow } from "@/lib/scheduleFetch";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SEASON = process.env.NBA_SEASON ?? "2026-27";

// Koko kauden otteluohjelma. stats.nba.com ei vastaa Vercelin palvelimille, joten
// käytetään NBA:n CDN:n staattista ohjelmaa ja varalla ESPN:ää.
// Ajetaan cronilla kerran viikossa ja käsin Games-sivun napista.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const endYear = Number(SEASON.slice(0, 4)) + 1;
  let rows: SchedRow[] = [];
  let source = "";
  const errors: string[] = [];
  try {
    rows = await fetchScheduleCdn();
    source = "NBA CDN";
    // CDN:n tiedosto voi vielä olla edellisen kauden: tarkistetaan vuosi
    if (!rows.some((r) => r.date >= `${endYear - 1}-10-01`)) {
      errors.push("NBA CDN: ohjelma ei ole vielä kaudelle " + SEASON);
      rows = [];
    }
  } catch (e: any) {
    errors.push(`NBA CDN: ${e?.message ?? e}`);
  }
  if (rows.length < 1000) {
    try {
      rows = await fetchScheduleEspn(endYear);
      source = "ESPN";
    } catch (e: any) {
      errors.push(`ESPN: ${e?.message ?? e}`);
    }
  }
  if (rows.length === 0) {
    return NextResponse.json({ ok: false, error: `Otteluohjelmaa ei saatu. ${errors.join(" · ")}` }, { status: 502 });
  }

  const supabase = getSupabaseAdmin();
  // ESPN-rivit eivät tunne NBA:n game_id:tä: poistetaan saman kauden tulevat ottelut, joilla
  // ei ole tulosta, ennen kuin uudet lisätään, jotta ei synny tuplia.
  const seasonStart = `${endYear - 1}-10-01`;
  const { error: delErr } = await supabase.from("schedule").delete().gte("date", seasonStart).is("home_score", null);
  if (delErr) return NextResponse.json({ ok: false, error: `Vanhojen rivien poisto: ${delErr.message}` }, { status: 500 });
  const { data: played } = await supabase.from("schedule").select("date, home, away").gte("date", seasonStart);
  const playedKey = new Set((played ?? []).map((g: any) => `${g.date}|${g.home}|${g.away}`));
  const fresh = rows.filter((r) => !playedKey.has(`${r.date}|${r.home}|${r.away}`));
  for (let i = 0; i < fresh.length; i += 500) {
    const { error } = await supabase.from("schedule").upsert(fresh.slice(i, i + 500), { onConflict: "game_id" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, source, total: rows.length, inserted: fresh.length, notes: errors });
}
