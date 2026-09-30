import { teamAvailability, type TeamAvailability } from "./availability";
import { computeOffseason, leagueNormalize, canonTeam, type PrevRow, type OffseasonTeam } from "./prevSeason";

// Kauden 26-27 lähtötaso (preseason) — sama laskenta Matchupissa ja Teams-sivulla.
//  1. kausiblendi (25-26 / 24-25)
//  2. jaetaan pelaajista selittyvään osaan (Σ EPM × pohjaminuutit) ja jäännökseen;
//     kumpikin regressoidaan liigakeskiarvoa kohti omalla kertoimellaan
//  3. + kesän muutos (rosteri nyt − pohja), pelaajakertoimella
//  4. + valinnainen siirto kohti win totalista johdettua Netiä
export type PreTeam = {
  team: string;
  pace_2425: number | null;
  ortg_2425: number | null;
  drtg_2425: number | null;
  pace_2526: number | null;
  ortg_2526: number | null;
  drtg_2526: number | null;
  coach_change: boolean | null;
  win_total?: number | null;
};
export type PreSettings = {
  blendWeight: number; // 0–100, paino kaudelle 25-26
  carry: { player: number; res: number; pace: number }; // %
  leagueNorm: boolean;
  marketWeight: number; // 0–100
  paceShift?: number; // kauden alun tempotason korjaus (possessioita, kaikille joukkueille)
  ratingSource?: "epm" | "darko" | "avg"; // pelaaja-arvioiden lähde
};
export const DEFAULT_PRE_SETTINGS: PreSettings = {
  blendWeight: 100,
  carry: { player: 85, res: 50, pace: 50 },
  leagueNorm: true,
  marketWeight: 0,
};
export const SETTINGS_KEYS = {
  blend: "matchup_blend_weight_v1",
  carry: "matchup_carry_v2",
  leagueNorm: "matchup_league_norm_v1",
  market: "matchup_market_weight_v1",
};
// Matchupin asetukset tästä selaimesta (Teams-sivu käyttää samoja).
export function loadPreSettings(): PreSettings {
  const s: PreSettings = JSON.parse(JSON.stringify(DEFAULT_PRE_SETTINGS));
  try {
    const b = localStorage.getItem(SETTINGS_KEYS.blend);
    if (b != null && !Number.isNaN(Number(b))) s.blendWeight = Number(b);
    const c = JSON.parse(localStorage.getItem(SETTINGS_KEYS.carry) ?? "null");
    if (c && typeof c.player === "number" && typeof c.res === "number" && typeof c.pace === "number") s.carry = c;
    if (localStorage.getItem(SETTINGS_KEYS.leagueNorm) === "0") s.leagueNorm = false;
    const m = Number(localStorage.getItem(SETTINGS_KEYS.market));
    if (m >= 0 && m <= 100) s.marketWeight = m;
  } catch {
    // oletukset
  }
  return s;
}

export const WINS_PER_NET = 2.7;
const DEFAULT_PACE = 100;

export type PreRow = {
  team: string;
  blendO: number; // kausiblendi ennen regressiota
  blendD: number;
  blendP: number;
  resO: number; // jäännös ennen regressiota (+ = parempi)
  resD: number;
  ortgBlend: number; // regressoitu lähtötaso (+ markkinasiirto), ilman kesän muutosta
  drtgBlend: number;
  paceBlend: number;
  offO: number; // kesän muutos pelaajakertoimella (+ = parempi)
  offD: number;
  mktShift: number; // Net-siirto kohti win totalia
  ortg: number; // preseason 26-27
  drtg: number;
  net: number;
  // Tunnettujen pitkien poissaolojen vaikutus kauden keskitasoon (× pelaajakerroin, + = menetys).
  // Ei sisälly ortg/drtg/net-lukuihin (Matchup käsittelee poissaolot ottelukohtaisesti),
  // vaan seasonNet-lukuun, jota käytetään win total -vertailussa ja kausisimulaatiossa.
  availO: number;
  availD: number;
  seasonNet: number;
  avail?: TeamAvailability;
  off?: OffseasonTeam;
};
export type WinRow = { team: string; wins: number; mkt: number; model: number; diff: number };

export function computePreseason(
  teams: PreTeam[],
  players: { team: string; name: string; oepm: number; depm: number; mpg_base: number; active: boolean; nba_id?: number | null }[],
  prevRows: PrevRow[],
  s: PreSettings,
  rawOffseason?: Record<string, OffseasonTeam>,
  games?: { date: string; home: string; away: string; season_type?: string }[] | null
) {
  const avail = teamAvailability(players as any, games);
  const usePrev = prevRows.length > 0;
  const raw = rawOffseason ?? (usePrev ? computeOffseason(players as any, prevRows) : {});
  const norm = leagueNormalize(raw);
  const offseason = s.leagueNorm ? norm.teams : raw;
  const offTeams = Object.values(offseason).filter((t) => canonTeam(t.team));
  const explMean = offTeams.length
    ? { o: offTeams.reduce((a, t) => a + t.prevO, 0) / offTeams.length, d: offTeams.reduce((a, t) => a + t.prevD, 0) / offTeams.length }
    : { o: 0, d: 0 };

  const blendOf = (t: PreTeam) => {
    const w = t.coach_change ? 1 : s.blendWeight / 100;
    const mix = (a: number | null, b: number | null) => (a ?? b ?? DEFAULT_PACE) * w + (b ?? a ?? DEFAULT_PACE) * (1 - w);
    return { o: mix(t.ortg_2526, t.ortg_2425), d: mix(t.drtg_2526, t.drtg_2425), p: mix(t.pace_2526, t.pace_2425) };
  };
  const bs = teams.map(blendOf);
  const L = bs.length ? bs.reduce((a, b) => a + (b.o + b.d) / 2, 0) / bs.length : 114;
  const LP = bs.length ? bs.reduce((a, b) => a + b.p, 0) / bs.length : DEFAULT_PACE;
  const kpl = s.carry.player / 100;
  const kres = s.carry.res / 100;
  const kp = s.carry.pace / 100;

  const byTeam: Record<string, PreRow> = {};
  teams.forEach((t, i) => {
    const bl = bs[i];
    const base = usePrev ? offseason[t.team] : undefined;
    const explO = base ? base.prevO - explMean.o : 0;
    const explD = base ? base.prevD - explMean.d : 0;
    const resO = base ? bl.o - L - explO : 0;
    const resD = base ? L - bl.d - explD : 0;
    const ortgBlend = base ? L + kpl * explO + kres * resO : L + kpl * (bl.o - L);
    const drtgBlend = base ? L - kpl * explD - kres * resD : L + kpl * (bl.d - L);
    const paceBlend = LP + kp * (bl.p - LP) + (s.paceShift ?? 0);
    const offO = (base?.offO ?? 0) * kpl;
    const offD = (base?.offD ?? 0) * kpl;
    byTeam[t.team] = {
      team: t.team,
      blendO: bl.o,
      blendD: bl.d,
      blendP: bl.p,
      resO,
      resD,
      ortgBlend,
      drtgBlend,
      paceBlend,
      offO,
      offD,
      mktShift: 0,
      ortg: ortgBlend + offO,
      drtg: drtgBlend - offD,
      net: ortgBlend + offO - (drtgBlend - offD),
      availO: (avail[t.team]?.o ?? 0) * kpl,
      availD: (avail[t.team]?.d ?? 0) * kpl,
      seasonNet: ortgBlend + offO - (drtgBlend - offD) - ((avail[t.team]?.o ?? 0) + (avail[t.team]?.d ?? 0)) * kpl,
      avail: avail[t.team],
      off: base,
    };
  });

  // Win totalit -> markkinan Net (liigakeskiarvoon nähden) ja siirto kohti sitä.
  const withWins = teams.filter((t) => t.win_total != null && !Number.isNaN(Number(t.win_total)));
  let winRows: WinRow[] = [];
  if (withWins.length >= 20) {
    const mMean = withWins.reduce((a, t) => a + byTeam[t.team].seasonNet, 0) / withWins.length;
    const imp = withWins.map((t) => (Number(t.win_total) - 41) / WINS_PER_NET);
    const iMean = imp.reduce((a, x) => a + x, 0) / imp.length;
    winRows = withWins.map((t, i) => {
      const model = byTeam[t.team].seasonNet - mMean;
      const mkt = imp[i] - iMean;
      return { team: t.team, wins: Number(t.win_total), mkt, model, diff: mkt - model };
    });
    if (s.marketWeight > 0) {
      for (const r of winRows) {
        const p = byTeam[r.team];
        const sh = r.diff * (s.marketWeight / 100);
        p.mktShift = sh;
        p.ortgBlend += sh / 2;
        p.drtgBlend -= sh / 2;
        p.ortg += sh / 2;
        p.drtg -= sh / 2;
        p.net += sh;
        p.seasonNet += sh;
      }
    }
  }
  return { byTeam, winRows, meanO: norm.meanO, meanD: norm.meanD, offseason, leagueAvg: L, leaguePace: LP };
}

// Kalibrointi: haetaan regressiokertoimet (pelaajat / jäännös), joilla mallin kauden alun
// Net-erot osuvat lähimmäs markkinan win totaleista johdettuja. Kalibroidaan vain kaksi
// yleistä kerrointa, ei joukkuekohtaisia lukuja — joukkuekohtaiset erot jäävät näkyviin.
export function calibrateCarry(
  teams: PreTeam[],
  players: Parameters<typeof computePreseason>[1],
  prevRows: PrevRow[],
  s: PreSettings,
  games?: Parameters<typeof computePreseason>[5]
) {
  const raw = prevRows.length > 0 ? computeOffseason(players as any, prevRows) : {};
  const score = (player: number, res: number) => {
    const out = computePreseason(teams, players, prevRows, { ...s, marketWeight: 0, carry: { ...s.carry, player, res } }, raw, games);
    const r = out.winRows;
    if (r.length === 0) return null;
    const rmse = Math.sqrt(r.reduce((a, x) => a + x.diff * x.diff, 0) / r.length);
    // kulmakerroin: markkina = k × malli (k < 1 -> malli liian hajallaan)
    const k = r.reduce((a, x) => a + x.mkt * x.model, 0) / Math.max(1e-9, r.reduce((a, x) => a + x.model * x.model, 0));
    return { player, res, rmse, slope: k };
  };
  const current = score(s.carry.player, s.carry.res);
  const grid: NonNullable<ReturnType<typeof score>>[] = [];
  for (let player = 40; player <= 100; player += 5)
    for (let res = 0; res <= 100; res += 10) {
      const x = score(player, res);
      if (x) grid.push(x);
    }
  grid.sort((a, b) => a.rmse - b.rmse);
  return { current, best: grid[0] ?? null, grid };
}

// Asetukset tietokannasta (app_settings.model), paikallinen selain varalla.
export async function loadPreSettingsRemote(): Promise<PreSettings> {
  const local = loadPreSettings();
  try {
    const j = await fetch("/api/settings").then((r) => r.json());
    const m = j?.settings?.model;
    if (!m) return local;
    return {
      blendWeight: typeof m.blendWeight === "number" ? m.blendWeight : local.blendWeight,
      carry: m.carry && typeof m.carry.player === "number" ? m.carry : local.carry,
      leagueNorm: typeof m.leagueNorm === "boolean" ? m.leagueNorm : local.leagueNorm,
      marketWeight: typeof m.marketWeight === "number" ? m.marketWeight : local.marketWeight,
      paceShift: typeof m.paceShift === "number" ? m.paceShift : local.paceShift,
      ratingSource: m.ratingSource === "epm" || m.ratingSource === "darko" || m.ratingSource === "avg" ? m.ratingSource : "avg",
    };
  } catch {
    return local;
  }
}
