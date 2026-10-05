import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchAll } from "@/lib/fetchAll";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const fetchCache = "force-no-store";

// GET palauttaa KAIKKI ottelut (pelatut + tulevat) päivämäärän mukaan
// nousevassa järjestyksessä — vanhin ensin, uusin viimeisenä. Matchup-sivun
// EWMA-laskenta suodattaa itse pois ottelut joilla ei vielä ole tulosta
// (home_ortg == null), joten sama data käy sekä Matchup- että Games-sivulle.
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await fetchAll((a, b) => supabase.from("schedule").select("*").order("date", { ascending: true }).order("id").range(a, b));
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  // Turvaverkko tuplia vastaan: sama rivi (id) tai sama ottelu (päivä + koti + vieras) vain kerran.
  // Pidetään tuloksellinen, sitten NBA:n oma id (ei 'espn-').
  const rank = (g: any) =>
    (g.home_score != null ? 0 : 4) + (g.season_type === "pre" ? 0 : 2) + (String(g.game_id ?? "").startsWith("espn-") ? 1 : 0);
  const best = new Map<string, any>();
  const seenId = new Set<string>();
  let dupRows = 0;
  for (const g of data ?? []) {
    if (seenId.has(g.id)) {
      dupRows++;
      continue;
    }
    seenId.add(g.id);
    const k = `${g.date}|${g.home}|${g.away}`;
    const cur = best.get(k);
    if (!cur) best.set(k, g);
    else {
      dupRows++;
      if (rank(g) < rank(cur)) best.set(k, g);
    }
  }
  const games = Array.from(best.values()).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return NextResponse.json(
    { games, rawRows: (data ?? []).length, duplicatesHidden: dupRows },
    { headers: { "Cache-Control": "no-store, max-age=0" } }
  );
}
