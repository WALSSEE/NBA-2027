import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET palauttaa KAIKKI ottelut (pelatut + tulevat) päivämäärän mukaan
// nousevassa järjestyksessä — vanhin ensin, uusin viimeisenä. Matchup-sivun
// EWMA-laskenta suodattaa itse pois ottelut joilla ei vielä ole tulosta
// (home_ortg == null), joten sama data käy sekä Matchup- että Games-sivulle.
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("schedule").select("*").order("date", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ games: data ?? [] });
}
