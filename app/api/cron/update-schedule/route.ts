import { NextResponse } from "next/server";
import { fetchScheduleCdn, fetchScheduleEspn, type SchedRow } from "@/lib/scheduleFetch";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchAll } from "@/lib/fetchAll";

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
    if (!rows.some((r) => r.season_type === "reg" && r.date >= `${endYear - 1}-10-01`)) {
      errors.push("NBA CDN: ohjelma ei ole vielä kaudelle " + SEASON);
      rows = [];
    }
  } catch (e: any) {
    errors.push(`NBA CDN: ${e?.message ?? e}`);
  }
  if (rows.filter((r) => r.season_type === "reg").length < 1150) {
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
  const seasonStart = `${endYear - 1}-09-20`; // harjoituskausi mukaan
  const { error: delErr, count: deletedOld } = await supabase.from("schedule").delete({ count: "exact" }).gte("date", seasonStart).is("home_score", null);
  if (delErr) return NextResponse.json({ ok: false, error: `Vanhojen rivien poisto: ${delErr.message}` }, { status: 500 });
  const { data: played } = await fetchAll((a, b) => supabase.from("schedule").select("date, home, away").gte("date", seasonStart).order("id").range(a, b));
  const playedKey = new Set((played ?? []).map((g: any) => `${g.date}|${g.home}|${g.away}`));
  const fresh = rows.filter((r) => !playedKey.has(`${r.date}|${r.home}|${r.away}`));
  for (let i = 0; i < fresh.length; i += 500) {
    const { error } = await supabase.from("schedule").upsert(fresh.slice(i, i + 500), { onConflict: "game_id" });
    if (error) return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
  // Vanhentuneet rivit: pelaamaton ottelu, jota ei ole tässä haussa (esim. toisen lähteen id) -> pois.
  let removedStale = 0;
  {
    const keep = new Set(fresh.map((r) => r.game_id));
    const { data: unplayed } = await fetchAll((a, b) =>
      supabase.from("schedule").select("id, game_id").gte("date", seasonStart).is("home_score", null).order("id").range(a, b)
    );
    const stale = (unplayed ?? []).filter((g: any) => !keep.has(g.game_id)).map((g: any) => g.id);
    for (let i = 0; i < stale.length; i += 200) {
      const { error } = await supabase.from("schedule").delete().in("id", stale.slice(i, i + 200));
      if (error) return NextResponse.json({ ok: false, error: `Vanhentuneiden poisto: ${error.message}` }, { status: 500 });
    }
    removedStale = stale.length;
  }
  // Tuplien siivous: sama ottelu (päivä + koti + vieras) voi tulla kahdesti, jos kaksi hakua ajetaan
  // yhtä aikaa (cron + nappi) tai lähde vaihtuu (NBA CDN / ESPN). Pidetään tuloksellinen, sitten NBA:n id.
  let removedDup = 0;
  {
    const { data: all } = await fetchAll((a, b) =>
      supabase.from("schedule").select("id, game_id, date, home, away, home_score, season_type").gte("date", seasonStart).order("id").range(a, b)
    );
    const groups = new Map<string, any[]>();
    for (const g of all ?? []) {
      const k = `${g.date}|${g.home}|${g.away}`;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(g);
    }
    const rank = (g: any) =>
    (g.home_score != null ? 0 : 4) + (g.season_type === "pre" ? 0 : 2) + (String(g.game_id ?? "").startsWith("espn-") ? 1 : 0);
    const del: string[] = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((x, y) => rank(x) - rank(y) || String(x.id).localeCompare(String(y.id)));
      for (const g of list.slice(1)) if (g.home_score == null) del.push(g.id);
    }
    for (let i = 0; i < del.length; i += 200) {
      const { error } = await supabase.from("schedule").delete().in("id", del.slice(i, i + 200));
      if (error) return NextResponse.json({ ok: false, error: `Tuplien poisto: ${error.message}` }, { status: 500 });
    }
    removedDup = del.length;
  }
  const reg = rows.filter((r) => r.season_type === "reg").length;
  return NextResponse.json({ ok: true, source, total: rows.length, regular: reg, preseason: rows.length - reg, inserted: fresh.length, removedDuplicates: removedDup + removedStale, deletedBefore: deletedOld ?? null, notes: errors });
}
