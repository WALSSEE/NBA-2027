import { TEAM_NAME_BY_ABBR } from "./teamNames";
import { normalizePlayerName } from "./parseTransactions";

export const PREV_SEASON = "2025-26";
export const TEAM_GAMES = 82;

export type PrevRow = { team: string; name: string; nba_id?: number | null; gp: number; min_total: number };

// Basketball-Referencen joukkuelyhenteet, jotka eroavat NBA:n omista.
const BREF_ABBR: Record<string, string> = { BRK: "BKN", CHO: "CHA", PHO: "PHX" };

function toNum(s: string | undefined): number {
  if (s == null) return NaN;
  const t = s.trim().replace(/−/g, "-").replace(/\s/g, "");
  if (t === "") return NaN;
  // "1 234,5" / "1234.5" / "1,234" (tuhaterotin) -> numero
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return Number(t.replace(/,/g, ""));
  return Number(t.replace(",", "."));
}

// Jäsentää Basketball-Referencen "Totals"-taulukon (kopioitu sivulta tai
// "Get table as CSV"). Tarvitaan sarakkeet Player, Team (tai Tm), G ja MP.
// Kesken kauden treidatuilla on oma rivi jokaiselle joukkueelle sekä
// yhteenvetorivi (2TM/3TM/TOT), joka ohitetaan.
export function parseBrefTotals(raw: string): { rows: PrevRow[]; warnings: string[] } {
  const warnings: string[] = [];
  const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return { rows: [], warnings: ["Tyhjä liite."] };
  const delim = lines.some((l) => l.includes("\t")) ? "\t" : ",";
  const split = (l: string) => l.split(delim).map((c) => c.trim());

  const headerIdx = lines.findIndex((l) => {
    const c = split(l).map((x) => x.toLowerCase());
    return c.includes("player") && (c.includes("team") || c.includes("tm")) && c.includes("mp");
  });
  if (headerIdx === -1) {
    return { rows: [], warnings: ["Otsikkoriviä ei löytynyt (tarvitaan sarakkeet Player, Team, G, MP)."] };
  }
  const header = split(lines[headerIdx]).map((x) => x.toLowerCase());
  const iPlayer = header.indexOf("player");
  const iTeam = header.includes("team") ? header.indexOf("team") : header.indexOf("tm");
  const iG = header.indexOf("g");
  const iMP = header.indexOf("mp");
  if (iG === -1) warnings.push("Saraketta G (pelit) ei löytynyt — pelimäärä jää 0:ksi.");

  const byKey = new Map<string, PrevRow>();
  let skippedTeams = 0;
  for (const line of lines.slice(headerIdx + 1)) {
    const c = split(line);
    const name = (c[iPlayer] ?? "").replace(/\*$/, "").trim();
    if (!name || name.toLowerCase() === "player" || /league average/i.test(name)) continue;
    const abbrRaw = (c[iTeam] ?? "").toUpperCase();
    if (/^(\d+TM|TOT)$/.test(abbrRaw)) continue; // usean joukkueen yhteenvetorivi
    const abbr = BREF_ABBR[abbrRaw] ?? abbrRaw;
    const team = TEAM_NAME_BY_ABBR[abbr];
    if (!team) {
      skippedTeams += 1;
      continue;
    }
    const mp = toNum(c[iMP]);
    const g = iG === -1 ? 0 : toNum(c[iG]);
    if (Number.isNaN(mp)) continue;
    byKey.set(`${team}::${name}`, { team, name, gp: Number.isNaN(g) ? 0 : Math.round(g), min_total: mp });
  }
  if (skippedTeams > 0) warnings.push(`${skippedTeams} riviä ohitettu tuntemattoman joukkuelyhenteen takia.`);
  return { rows: [...byKey.values()], warnings };
}

type EpmPlayer = { team: string; name: string; oepm: number; depm: number; mpg_base: number; active: boolean; nba_id?: number | null };

export type OffseasonTeam = {
  team: string;
  roleMin: number; // nykyisen rosterin oletusminuutit yhteensä (ennen skaalausta)
  roleScale: number; // kerroin, jolla oletusminuutit skaalataan summaan 240
  prevMin: number; // viime kauden vaikutusminuutit yhteensä (≈ 240)
  roleO: number;
  roleD: number;
  prevO: number;
  prevD: number;
  offO: number; // kesän muutos, O (pistettä / 100 poss)
  offD: number; // kesän muutos, D (positiivinen = parempi puolustus)
  unmatched: { name: string; effMin: number }[]; // viime kauden pelaajat, joiden EPM puuttuu
};

// Kesän muutos per joukkue:
//   Σ nykyinen rosteri (EPM × oletusmin / 48) − Σ viime kauden pelaajat (EPM × (kokonaismin / 82) / 48)
// Viime kauden pelaajan EPM haetaan players-taulusta nimellä (tai nba_id:llä),
// riippumatta siitä missä joukkueessa hän nyt on.
export function computeOffseason(players: EpmPlayer[], prev: PrevRow[]): Record<string, OffseasonTeam> {
  const epmById = new Map<number, EpmPlayer>();
  const epmByName = new Map<string, EpmPlayer>();
  // Varatunnistus: sukunimi + etunimen kaksi ensimmäistä kirjainta
  // ("Ronald Holland II" = "Ron Holland", "Scotty Pippen Jr." = "Scottie Pippen Jr").
  const epmByLoose = new Map<string, EpmPlayer[]>();
  for (const p of players) {
    if (p.nba_id) epmById.set(Number(p.nba_id), p);
    const k = normalizePlayerName(p.name);
    // useampi rivi samalla nimellä -> suositaan aktiivista / minuutillista
    const cur = epmByName.get(k);
    if (!cur || (!cur.active && p.active) || (cur.mpg_base === 0 && p.mpg_base > 0)) epmByName.set(k, p);
    const lk = looseKey(p.name);
    if (lk) (epmByLoose.get(lk) ?? epmByLoose.set(lk, []).get(lk)!).push(p);
  }
  const findEpm = (r: PrevRow): EpmPlayer | undefined => {
    if (r.nba_id && epmById.has(Number(r.nba_id))) return epmById.get(Number(r.nba_id));
    const exact = epmByName.get(normalizePlayerName(r.name));
    if (exact) return exact;
    const cands = epmByLoose.get(looseKey(r.name) ?? "") ?? [];
    const distinct = new Set(cands.map((c) => normalizePlayerName(c.name)));
    if (distinct.size === 1) return cands[0];
    return undefined; // monitulkintainen -> ei arvata
  };

  const out: Record<string, OffseasonTeam> = {};
  const get = (team: string) =>
    (out[team] ??= { team, roleMin: 0, roleScale: 1, prevMin: 0, roleO: 0, roleD: 0, prevO: 0, prevD: 0, offO: 0, offD: 0, unmatched: [] });

  // Kentällä on aina 240 minuuttia: oletusminuutit ovat roolien painoja, ja ne
  // skaalataan joukkueittain summaan 240 (ks. teamMinuteScale).
  const scale = teamMinuteScale(players);
  for (const p of players) {
    const team = canonTeam(p.team);
    if (!team) continue; // Free Agent tms.
    const raw = p.active ? Number(p.mpg_base) || 0 : 0;
    const m = raw * (scale[team] ?? 1);
    const t = get(team);
    t.roleMin += raw;
    t.roleScale = scale[team] ?? 1;
    t.roleO += (p.oepm * m) / 48;
    t.roleD += (p.depm * m) / 48;
  }
  for (const r of prev) {
    const eff = r.min_total / TEAM_GAMES;
    const t = get(r.team);
    t.prevMin += eff;
    const p = findEpm(r);
    if (!p) {
      if (eff >= 0.5) t.unmatched.push({ name: r.name, effMin: eff });
      continue;
    }
    t.prevO += (p.oepm * eff) / 48;
    t.prevD += (p.depm * eff) / 48;
  }
  for (const t of Object.values(out)) {
    t.offO = t.roleO - t.prevO;
    t.offD = t.roleD - t.prevD;
    t.unmatched.sort((a, b) => b.effMin - a.effMin);
  }
  return out;
}

const normTeam = (t: string) => (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const CANON = new Map(Object.values(TEAM_NAME_BY_ABBR).map((t) => [normTeam(t), t]));
// Palauttaa NBA-joukkueen virallisen nimen (sietää välilyöntieroja), muuten null.
export function canonTeam(team: string): string | null {
  return CANON.get(normTeam(team)) ?? null;
}

function looseKey(name: string): string | null {
  const parts = normalizePlayerName(name).split(" ").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[parts.length - 1]}|${parts[0].slice(0, 2)}`;
}

// Joukkuekohtainen kerroin, jolla aktiivisten pelaajien oletusminuutit
// skaalataan summaan 240. Joukkue, jolla ei ole minuutteja -> 1.
export function teamMinuteScale(players: { team: string; mpg_base: number; active: boolean }[]): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const p of players) {
    const team = canonTeam(p.team);
    if (!team || !p.active) continue;
    sums[team] = (sums[team] ?? 0) + (Number(p.mpg_base) || 0);
  }
  const out: Record<string, number> = {};
  for (const [team, sum] of Object.entries(sums)) out[team] = sum > 0 ? 240 / sum : 1;
  return out;
}
