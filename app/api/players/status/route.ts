import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Päivittää pelaajan poissaolotilan (Matchup-sivun OUT / IN -napit).
// body: { playerId, outSince?: "YYYY-MM-DD" | null, outUntil?: "YYYY-MM-DD" | null, gpPrevSeason?: 0–82 | null }
// Vain mukana olevat kentät päivitetään.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const playerId = body?.playerId ? String(body.playerId) : null;
  if (!playerId) {
    return NextResponse.json({ error: "playerId vaaditaan." }, { status: 400 });
  }
  const dateOk = (v: any) => v === null || (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v));
  const update: Record<string, string | null> = {};
  if ("outSince" in body) {
    if (!dateOk(body.outSince)) return NextResponse.json({ error: "outSince: päivämäärä muodossa YYYY-MM-DD tai null." }, { status: 400 });
    update.out_since = body.outSince;
  }
  if ("outUntil" in body) {
    if (!dateOk(body.outUntil)) return NextResponse.json({ error: "outUntil: päivämäärä muodossa YYYY-MM-DD tai null." }, { status: 400 });
    update.out_until = body.outUntil;
  }
  if ("gpPrevSeason" in body) {
    const v = body.gpPrevSeason;
    if (v !== null && !(Number.isInteger(v) && v >= 0 && v <= 82)) {
      return NextResponse.json({ error: "gpPrevSeason: kokonaisluku 0–82 tai null." }, { status: 400 });
    }
    (update as Record<string, unknown>).gp_prev_season = v;
  }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Ei päivitettäviä kenttiä." }, { status: 400 });
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("players").update(update).eq("id", playerId);
  if (error) {
    return NextResponse.json(
      { error: `${error.message}. Onko supabase/add_players_prev_season.sql ajettu Supabasessa?` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
