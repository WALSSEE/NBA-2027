import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Alkutilanne (Excelin rosterit ja minuutit) — pohja joukkueiden luvuille.
export async function GET() {
  const supabase = getSupabaseAdmin();
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("season_start_roster")
      .select("id, team, name, mpg, in_team, oepm, depm")
      .order("team")
      .order("mpg", { ascending: false })
      .range(from, from + 999);
    if (error) {
      return NextResponse.json({ error: `${error.message}. Onko supabase/setup_season_start.sql ajettu?`, rows: [] }, { status: 500 });
    }
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  return NextResponse.json({ rows });
}

// Yhden alkutilanteen rivin minuuttien muokkaus: { id, mpg }
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const mpg = Number(body?.mpg);
  if (!body?.id || !Number.isFinite(mpg) || mpg < 0 || mpg > 48) {
    return NextResponse.json({ error: "id ja mpg (0–48) vaaditaan." }, { status: 400 });
  }
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("season_start_roster").update({ mpg }).eq("id", body.id).select().single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true, row: data });
}
