import { canonTeam, looseKey, fuzzyFind, TEAM_GAMES } from "./prevSeason";
import { normalizePlayerName } from "./parseTransactions";

type Row = Record<string, unknown>;
type Prev = { team: string; name: string; min_total: number; final_team?: boolean | null };
type Player = { id: string; team: string; name: string; active: boolean; mpg_base: number };

// Suunnitelma kauden 25-26 lähtötilanteeseen palauttamiseksi (ks. /api/offseason/reset):
//   - jokainen 25-26 pelannut -> kauden viimeiseen joukkueeseensa
//   - oletusminuutit = hänen KOKO kauden minuuttinsa / 82 (kaikki joukkueet yhteensä),
//     eli täsmälleen se painoarvo, jolla hän oli mukana joukkueiden 25-26 luvuissa
//   - muuttumaton rosteri -> kesän muutos 0; kesken kauden treidattu pelaaja näkyy
//     uudessa joukkueessaan koko kauden painolla (todellinen muutos)
//   - pelaajat, joita 25-26 datassa ei ole (tulokkaat, koko kauden missanneet) -> 0 min
//   - 25-26 pelaaja, jota ei ole kannassa -> lisätään EPM 0:lla (= liigan keskitaso,
//     sama oletus kuin pohjassa)
export function planReset(prev: Prev[], players: Player[]) {
  // 25-26 rivit pelaajittain
  const ident = new Map<string, { name: string; total: number; finalTeam: string }>();
  for (const r of prev) {
    const k = normalizePlayerName(r.name);
    const cur = ident.get(k) ?? { name: r.name, total: 0, finalTeam: r.team };
    cur.total += Number(r.min_total) || 0;
    if (r.final_team !== false) cur.finalTeam = r.team;
    ident.set(k, cur);
  }

  const identNames = new Set(ident.keys());
  const byNorm = new Map<string, Player[]>();
  const byLoose = new Map<string, Player[]>();
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
  for (const [k, r] of ident) {
    const mpg = Math.round((r.total / TEAM_GAMES) * 100) / 100;
    let group = byNorm.get(k) ?? [];
    if (group.length === 0) {
      const cands = byLoose.get(looseKey(r.name) ?? "") ?? [];
      if (new Set(cands.map((c) => normalizePlayerName(c.name))).size === 1) group = cands;
    }
    group = group.filter((p) => !claimed.has(p.id));
    let rename: string | null = null;
    if (group.length === 0) {
      // kirjoitusvirhe kannan nimessä -> korjataan nimi 25-26 datan mukaiseksi
      const f = fuzzyFind(r.name, r.finalTeam, players.filter((p) => !claimed.has(p.id) && !identNames.has(normalizePlayerName(p.name))));
      if (f) {
        group = byNorm.get(normalizePlayerName(f.name))!.filter((p) => !claimed.has(p.id));
        rename = r.name;
      }
    }
    if (group.length === 0) {
      if (mpg > 0) inserts.push({ team: r.finalTeam, name: r.name, mpg_base: mpg, oepm: 0, depm: 0, active: true });
      continue;
    }
    const chosen = group.find((p) => canonTeam(p.team) === r.finalTeam) ?? group.find((p) => p.active) ?? group[0];
    for (const p of group) {
      claimed.add(p.id);
      if (p.id === chosen.id) {
        moves.push({ id: p.id, team: r.finalTeam, name: rename ?? p.name, mpg_base: mpg, active: true, out_since: null, out_until: null });
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
