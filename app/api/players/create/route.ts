import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Luo uuden pelaajan (esim. tulokas) ja palauttaa sen rivin id:n kanssa.
// Minuutit asetetaan 0:ksi — ne kirjataan heti perään tulo-transaktiona
// (/api/transactions, arrival: true), jotta vaikutus näkyy joukkueen luvuissa.
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const team = body?.team ? String(body.team).trim() : "";
  const name = body?.name ? String(body.name).trim() : "";
  if (!team || !name) {
    return NextResponse.json({ error: "team ja name vaaditaan." }, { status: 400 });
  }
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("players")
    .insert({
      team,
      name,
      pos: body?.pos ? String(body.pos) : "",
      mpg_base: 0,
      oepm: Number(body?.oepm) || 0,
      depm: Number(body?.depm) || 0,
      active: body?.active ?? true,
    })
    .select()
    .single();
  if (error) {
    const dup = /duplicate|unique/i.test(error.message);
    return NextResponse.json(
      { error: dup ? `${name} on jo joukkueessa ${team}.` : error.message },
      { status: dup ? 409 : 500 }
    );
  }
  return NextResponse.json({ ok: true, player: data });
}
