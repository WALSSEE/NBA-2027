import { canonTeam, looseKey } from "./prevSeason";
import { normalizePlayerName } from "./parseTransactions";

type Row = Record<string, unknown>;

// Suunnitelma alkutilanteen palautukseen (ks. /api/offseason/reset).
export function planReset(
  start: { team: string; name: string; mpg: number; in_team: boolean; oepm?: number | null; depm?: number | null }[],
  players: { id: string; team: string; name: string; active: boolean; mpg_base: number }[]
) {
  const byNorm = new Map<string, typeof players>();
  const byLoose = new Map<string, typeof players>();
  for (const p of players) {
    const n = normalizePlayerName(p.name);
    (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(p);
    const lk = looseKey(p.name);
    if (lk) (byLoose.get(lk) ?? byLoose.set(lk, []).get(lk)!).push(p);
  }
  const claimed = new Set<string>();
  const moves: Row[] = [];
  const deact: Row[] = [];
  const inserts: Row[] = [];
  for (const r of start) {
    if (!r.in_team) continue;
    let group = byNorm.get(normalizePlayerName(r.name)) ?? [];
    if (group.length === 0) {
      const cands = byLoose.get(looseKey(r.name) ?? "") ?? [];
      if (new Set(cands.map((c) => normalizePlayerName(c.name))).size === 1) group = cands;
    }
    group = group.filter((p) => !claimed.has(p.id));
    if (group.length === 0) {
      inserts.push({ team: r.team, name: r.name, mpg_base: Number(r.mpg) || 0, oepm: Number(r.oepm) || 0, depm: Number(r.depm) || 0, active: true });
      continue;
    }
    const chosen = group.find((p) => canonTeam(p.team) === r.team) ?? group.find((p) => p.active) ?? group[0];
    for (const p of group) {
      claimed.add(p.id);
      if (p.id === chosen.id) {
        moves.push({ id: p.id, team: r.team, name: p.name, mpg_base: Number(r.mpg) || 0, active: true, out_since: null, out_until: null });
      } else {
        deact.push({ id: p.id, team: p.team, name: p.name, mpg_base: 0, active: false, out_since: null, out_until: null });
      }
    }
  }
  const others = players
    .filter((p) => !claimed.has(p.id) && Number(p.mpg_base) !== 0)
    .map((p) => ({ id: p.id, team: p.team, name: p.name, mpg_base: 0 }));
  return { moves, deact, inserts, others };
}
