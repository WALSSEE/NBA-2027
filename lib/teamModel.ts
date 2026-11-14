// Joukkueen mallitaso ilman ottelukohtaista kokoonpanoa — sama laskenta kuin
// Matchup-laskurissa (lähtötaso + kesän muutos → EWMA pelatuista otteluista →
// kauden aikaiset siirrot → käsin tehdyt säädöt). Käyttävät Matchup ja Teams.

export type PlayedGame = { date: string; ortg: number; drtg: number; pace: number };
export type TxRow = { team: string; date: string; delta_o: number | string | null; delta_d: number | string | null };

export const LEAGUE_AVG_PACE = 100;

export function ewma(prior: number, values: number[], alpha: number): number {
  let rating = prior;
  for (const v of values) rating = alpha * v + (1 - alpha) * rating;
  return rating;
}

// Pelatut runkosarjaottelut joukkueittain (harjoituspelit pois).
export function gamesByTeamFrom(games: any[]): Record<string, PlayedGame[]> {
  const map: Record<string, PlayedGame[]> = {};
  for (const g of games) {
    if (g.home_ortg == null || g.away_ortg == null || g.season_type === "pre") continue;
    (map[g.home] ??= []).push({ date: g.date, ortg: Number(g.home_ortg), drtg: Number(g.home_drtg ?? 0), pace: Number(g.home_pace ?? LEAGUE_AVG_PACE) });
    (map[g.away] ??= []).push({ date: g.date, ortg: Number(g.away_ortg), drtg: Number(g.away_drtg ?? 0), pace: Number(g.away_pace ?? LEAGUE_AVG_PACE) });
  }
  for (const k of Object.keys(map)) map[k].sort((a, b) => a.date.localeCompare(b.date));
  return map;
}

export function seasonStartFrom(games: any[]): string {
  return games.reduce((m: string, g: any) => (g.season_type !== "pre" && g.date && g.date < m ? g.date : m), "9999-12-31");
}

export type TeamAdj = { adj_ortg?: number | null; adj_drtg?: number | null; adj_pace?: number | null };

export type TeamModel = {
  gamesPlayed: number;
  ortgActual: number; // EWMA (ilman siirtoja ja säätöjä)
  drtgActual: number;
  paceActual: number; // EWMA + tempon säätö
  paceEwma: number;
  netO: number; // kauden aikaiset siirrot
  netD: number;
  adjO: number; // käsin säätö (Teams-sivu)
  adjD: number;
  adjPace: number;
  shift: number; // liigan tehokkuussäätö (ORTG kaikille)
  modelOrtg: number; // EWMA + siirrot + säätö + tehokkuussäätö
  modelDrtg: number;
};

// pr = computePreseason(...).byTeam[team]; usePrev = uusi rakenne (viime kauden minuutit käytössä).
export function teamModelFor(
  team: string,
  pr: { ortgBlend: number; drtgBlend: number; paceBlend: number; offO: number; offD: number },
  opts: {
    played: PlayedGame[];
    transactions: TxRow[];
    alpha: number;
    paceAlpha: number;
    usePrev: boolean;
    seasonStart: string;
    refDate: string; // ottelupäivä; siirtojen painotus pelien mukaan ennen tätä
    adj?: TeamAdj | null;
    ortgShift?: number;
  }
): TeamModel {
  const { played, transactions, alpha, paceAlpha, usePrev, seasonStart, refDate } = opts;
  const ortgActual = ewma(pr.ortgBlend + pr.offO, played.map((g) => g.ortg), alpha);
  const drtgActual = ewma(pr.drtgBlend - pr.offD, played.map((g) => g.drtg), alpha);
  const paceEwma = ewma(pr.paceBlend, played.map((g) => g.pace), paceAlpha);

  const net = { o: 0, d: 0 };
  if (!usePrev) {
    for (const tx of transactions) {
      if (tx.team !== team) continue;
      const decay = Math.pow(1 - alpha, played.filter((g) => g.date >= tx.date).length);
      net.o += (Number(tx.delta_o) || 0) * decay;
      net.d += (Number(tx.delta_d) || 0) * decay;
    }
  } else {
    const before = played.filter((g) => g.date < refDate);
    const wAll = Math.pow(1 - alpha, before.length);
    for (const tx of transactions) {
      if (tx.team !== team || tx.date < seasonStart) continue;
      const wSince = Math.pow(1 - alpha, before.filter((g) => g.date >= tx.date).length);
      net.o += (Number(tx.delta_o) || 0) * (wSince - wAll);
      net.d += (Number(tx.delta_d) || 0) * (wSince - wAll);
    }
  }
  const adjO = Number(opts.adj?.adj_ortg) || 0;
  const adjD = Number(opts.adj?.adj_drtg) || 0;
  const adjPace = Number(opts.adj?.adj_pace) || 0;
  const shift = Number(opts.ortgShift) || 0;
  return {
    gamesPlayed: played.length,
    ortgActual,
    drtgActual,
    paceActual: paceEwma + adjPace,
    paceEwma,
    netO: net.o,
    netD: net.d,
    adjO,
    adjD,
    adjPace,
    shift,
    modelOrtg: ortgActual + net.o + adjO + shift,
    modelDrtg: drtgActual - net.d + adjD,
  };
}

// Liigan tehokkuussäätö (app_settings: efficiency.ortgShift). Lisätään kaikkien
// joukkueiden ORTG:hen: muuttaa totaleita (2 × säätö × pace/100), ei tasoituksia.
export async function loadEfficiencyShift(): Promise<number> {
  try {
    const j = await fetch("/api/settings").then((r) => r.json());
    const v = Number(j?.settings?.efficiency?.ortgShift);
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}
