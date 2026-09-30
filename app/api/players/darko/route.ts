import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchAll } from "@/lib/fetchAll";
import { normalizePlayerName } from "@/lib/parseTransactions";
import { looseKey, fuzzyFind, canonTeam } from "@/lib/prevSeason";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// DARKO-luvut pelaajille: { rows: [{ name, team, o, d }] }. Päivittää vain darko_o / darko_d.
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const rows: { name: string; team: string; o: number; d: number; mpg?: number }[] = Array.isArray(body?.rows) ? body.rows : [];
  if (rows.length === 0) return NextResponse.json({ error: "Ei rivejä." }, { status: 400 });
  const supabase = getSupabaseAdmin();
  const { data: players, error } = await fetchAll((a, b) => supabase.from("players").select("id, team, name").order("id").range(a, b));
  if (error) return NextResponse.json({ error: `${error.message}. Onko supabase/add_players_darko.sql ajettu?` }, { status: 500 });
  const byNorm = new Map<string, any[]>();
  const byLoose = new Map<string, any[]>();
  for (const p of players) {
    const n = normalizePlayerName(p.name);
    (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(p);
    const lk = looseKey(p.name);
    if (lk) (byLoose.get(lk) ?? byLoose.set(lk, []).get(lk)!).push(p);
  }
  const darkoNames = new Set(rows.map((r) => normalizePlayerName(r.name)));
  const pool = players.filter((p: any) => !darkoNames.has(normalizePlayerName(p.name)));
  const updates = new Map<string, Record<string, unknown>>();
  const unmatched: string[] = [];
  for (const r of rows) {
    let group = byNorm.get(normalizePlayerName(r.name)) ?? [];
    if (group.length === 0) {
      const c = byLoose.get(looseKey(r.name) ?? "") ?? [];
      if (new Set(c.map((x: any) => normalizePlayerName(x.name))).size === 1) group = c;
    }
    if (group.length === 0) {
      const f = fuzzyFind(r.name, canonTeam(r.team), pool);
      if (f) group = byNorm.get(normalizePlayerName(f.name)) ?? [f];
    }
    if (group.length === 0) {
      if ((r.mpg ?? 0) >= 10) unmatched.push(`${r.name} (${r.team}, ${r.mpg} mpg)`);
      continue;
    }
    for (const p of group) updates.set(p.id, { id: p.id, team: p.team, name: p.name, darko_o: r.o, darko_d: r.d });
  }
  const up = [...updates.values()];
  for (let i = 0; i < up.length; i += 500) {
    const { error: e } = await supabase.from("players").upsert(up.slice(i, i + 500), { onConflict: "id" });
    if (e) return NextResponse.json({ error: `${e.message}. Onko supabase/add_players_darko.sql ajettu?` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, rows: rows.length, updatedPlayers: up.length, unmatched });
}
