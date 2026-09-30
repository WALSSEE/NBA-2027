import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { fetchAll } from "@/lib/fetchAll";
import { normalizePlayerName } from "@/lib/parseTransactions";
import { looseKey, fuzzyFind, canonTeam } from "@/lib/prevSeason";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// BBall Indexin durability: { rows: [{ name, team, inj, role }] }. Päivittää vain inj82-sarakkeen.
export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const rows: { name: string; team: string; inj: number; role?: string }[] = Array.isArray(body?.rows) ? body.rows : [];
  if (rows.length === 0) return NextResponse.json({ error: "Ei rivejä." }, { status: 400 });
  const supabase = getSupabaseAdmin();
  const { data: players, error } = await fetchAll((a, b) => supabase.from("players").select("id, team, name").order("id").range(a, b));
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const byNorm = new Map<string, any[]>();
  const byLoose = new Map<string, any[]>();
  for (const p of players) {
    const n = normalizePlayerName(p.name);
    (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(p);
    const lk = looseKey(p.name);
    if (lk) (byLoose.get(lk) ?? byLoose.set(lk, []).get(lk)!).push(p);
  }
  const names = new Set(rows.map((r) => normalizePlayerName(r.name)));
  const pool = players.filter((p: any) => !names.has(normalizePlayerName(p.name)));
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
      if (r.role === "starter" || r.role === "rotation") unmatched.push(`${r.name} (${r.team || "—"}, ${r.role})`);
      continue;
    }
    for (const p of group) updates.set(p.id, { id: p.id, team: p.team, name: p.name, inj82: r.inj });
  }
  const up = [...updates.values()];
  for (let i = 0; i < up.length; i += 500) {
    const { error: e } = await supabase.from("players").upsert(up.slice(i, i + 500), { onConflict: "id" });
    if (e) return NextResponse.json({ error: `${e.message}. Onko supabase/add_players_inj82.sql ajettu?` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, rows: rows.length, updatedPlayers: up.length, unmatched });
}
