import { canonTeam, teamMinuteScale } from "./prevSeason";

// Korvaavan pelaajan taso (O/D per 100): minuuteilla painotettu keskiarvo 5–16 min pelaajista
// (EPM/DARKO-keskiarvo ≈ O −1.0, D −0.2). Kun pelaaja puuttuu, hänen minuuttinsa pelaa tämän
// tasoinen pelaaja — ei liigan keskitaso (0).
export const REPL_O = -1.0;
export const REPL_D = -0.3;

// Runkosarjan arvioidut rajat, jos otteluohjelmaa ei ole ladattu.
const SEASON_START = "2026-10-20";
const SEASON_END = "2027-04-12";

type AvPlayer = { team: string; name: string; oepm: number; depm: number; mpg_base: number; active: boolean; out_since?: string | null; out_until?: string | null };
type AvGame = { date: string; home: string; away: string; season_type?: string };

const dayNum = (d: string) => Math.round(Date.parse(d.slice(0, 10) + "T00:00:00Z") / 86400000);

// Osuus runkosarjasta, jonka pelaaja on poissa (poissa alkaen out_since, palaa out_until;
// ilman paluupäivää koko loppukausi).
export function missShare(p: AvPlayer, teamGames: string[] | null): number {
  if (!p.out_since) return 0;
  const from = p.out_since;
  const until = p.out_until ?? "9999-12-31";
  if (until <= from) return 0;
  if (teamGames && teamGames.length >= 60) {
    const n = teamGames.filter((d) => d >= from && d < until).length;
    return Math.min(1, n / Math.max(82, teamGames.length));
  }
  const s = dayNum(SEASON_START), e = dayNum(SEASON_END);
  const a = Math.max(s, dayNum(from)), b = Math.min(e, until.startsWith("9999") ? e : dayNum(until));
  return Math.max(0, Math.min(1, (b - a) / (e - s)));
}

export type TeamAvailability = { o: number; d: number; list: { name: string; share: number; o: number; d: number; min: number; until: string | null }[] };

// Tunnettujen pitkien poissaolojen vaikutus joukkueen kauden keskitasoon (per 100, + = menetys),
// ennen pelaajakerrointa: Σ (arvio − korvaava) × min/48 × poissaolo-osuus.
export function teamAvailability(players: AvPlayer[], games?: AvGame[] | null): Record<string, TeamAvailability> {
  const scale = teamMinuteScale(players);
  const reg = (games ?? []).filter((g) => g.season_type !== "pre");
  const start = reg.length ? reg.reduce((m, g) => (g.date < m ? g.date : m), "9999") : null;
  const byTeam: Record<string, string[]> = {};
  if (reg.length >= 1000) {
    for (const g of reg) {
      if (start && g.date < start) continue;
      (byTeam[g.home] ??= []).push(g.date);
      (byTeam[g.away] ??= []).push(g.date);
    }
  }
  const out: Record<string, TeamAvailability> = {};
  for (const p of players) {
    if (!p.active || !p.out_since || !(Number(p.mpg_base) > 0)) continue;
    const team = canonTeam(p.team);
    if (!team) continue;
    const share = missShare(p, byTeam[team] ?? null);
    if (share <= 0) continue;
    const min = Number(p.mpg_base) * (scale[team] ?? 1);
    const o = (Number(p.oepm) - REPL_O) * (min / 48) * share;
    const d = (Number(p.depm) - REPL_D) * (min / 48) * share;
    const t = (out[team] ??= { o: 0, d: 0, list: [] });
    t.o += o;
    t.d += d;
    t.list.push({ name: p.name, share, o, d, min, until: p.out_until ?? null });
  }
  return out;
}
