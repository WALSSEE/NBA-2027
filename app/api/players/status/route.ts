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
  // Tulokkaiden / pelaajien arvojen käsimuokkaus (Pelaajat → Tulokkaat).
  const num = (v: any) => typeof v === "number" && Number.isFinite(v);
  const upd = update as Record<string, unknown>;
  if ("oepm" in body) { if (!num(body.oepm)) return NextResponse.json({ error: "oepm: luku." }, { status: 400 }); upd.oepm = body.oepm; }
  if ("depm" in body) { if (!num(body.depm)) return NextResponse.json({ error: "depm: luku." }, { status: 400 }); upd.depm = body.depm; }
  if ("mpgBase" in body) { if (!num(body.mpgBase) || body.mpgBase < 0 || body.mpgBase > 48) return NextResponse.json({ error: "mpgBase: 0–48." }, { status: 400 }); upd.mpg_base = body.mpgBase; }
  if ("draftPick" in body) { const v = body.draftPick; if (v !== null && !(Number.isInteger(v) && v >= 1 && v <= 60)) return NextResponse.json({ error: "draftPick: 1–60 tai null." }, { status: 400 }); upd.draft_pick = v; }
  if ("team" in body) { if (typeof body.team !== "string" || !body.team.trim()) return NextResponse.json({ error: "team: joukkueen nimi." }, { status: 400 }); upd.team = body.team.trim(); }
  if ("active" in body) { if (typeof body.active !== "boolean") return NextResponse.json({ error: "active: true/false." }, { status: 400 }); upd.active = body.active; }
  if (Object.keys(update).length === 0) {
    return NextResponse.json({ error: "Ei päivitettäviä kenttiä." }, { status: 400 });
  }
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("players").update(update).eq("id", playerId);
  if (error) {
    return NextResponse.json(
      { error: `${error.message}. Onko tarvittava SQL (esim. add_rookies_2026.sql) ajettu Supabasessa?` },
      { status: 500 }
    );
  }
  return NextResponse.json({ ok: true });
}
