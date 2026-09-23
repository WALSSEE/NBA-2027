import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// GET palauttaa kaikki team_stats-rivit (ei vaadi salasanaa, sama tapa kuin
// /api/players/import GET) — tätä käyttää mm. Matchup-sivu, joka on client-
// komponentti eikä voi hakea dataa suoraan Supabasesta serverillä.
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("team_stats").select("*").order("team");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ teams: data ?? [] });
}
