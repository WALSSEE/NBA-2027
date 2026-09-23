import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET palauttaa PELATUT ottelut (home_score ei null) päivämäärän mukaan
// nousevassa järjestyksessä — vanhin ensin, uusin viimeisenä. Tätä
// järjestystä käyttää Matchup-sivun EWMA-laskenta (uusin peli käsitellään
// viimeisenä = saa suurimman painon).
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("schedule")
    .select("*")
    .not("home_score", "is", null)
    .order("date", { ascending: true });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ games: data ?? [] });
}
