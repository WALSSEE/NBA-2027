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

// POST päivittää yhden joukkueen team_stats-rivin (Teams-sivun muokkaus:
// ORTG/DRTG/Pace per kausi, coach_change, home_adv). Suojattu samalla
// CRON_SECRET-arvolla kuin muutkin kirjoittavat reitit.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const team = body?.team ? String(body.team).trim() : null;
  if (!team) {
    return NextResponse.json({ error: "team-kenttä vaaditaan." }, { status: 400 });
  }

  const fields = [
    "pace_2425",
    "ortg_2425",
    "drtg_2425",
    "pace_2526",
    "ortg_2526",
    "drtg_2526",
    "home_adv",
  ] as const;

  const update: Record<string, any> = {};
  for (const f of fields) {
    if (body[f] !== undefined && body[f] !== null && body[f] !== "") {
      const n = Number(body[f]);
      if (!Number.isNaN(n)) update[f] = n;
    }
  }
  if (typeof body.coach_change === "boolean") {
    update.coach_change = body.coach_change;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Ei päivitettäviä kenttiä." }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("team_stats").upsert({ team, ...update }, { onConflict: "team" });
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ ok: true, team });
}
