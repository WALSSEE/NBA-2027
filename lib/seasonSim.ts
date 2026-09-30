import { normalizePlayerName } from "./parseTransactions";
import { canonTeam, type PrevRow } from "./prevSeason";

// Konferenssit ja divisioonat (2026-27).
export const DIVISIONS: Record<string, { conf: "East" | "West"; teams: string[] }> = {
  Atlantic: { conf: "East", teams: ["Boston Celtics", "Brooklyn Nets", "New York Knicks", "Philadelphia 76ers", "Toronto Raptors"] },
  Central: { conf: "East", teams: ["Chicago Bulls", "Cleveland Cavaliers", "Detroit Pistons", "Indiana Pacers", "Milwaukee Bucks"] },
  Southeast: { conf: "East", teams: ["Atlanta Hawks", "Charlotte Hornets", "Miami Heat", "Orlando Magic", "Washington Wizards"] },
  Northwest: { conf: "West", teams: ["Denver Nuggets", "Minnesota Timberwolves", "Oklahoma City Thunder", "Portland Trail Blazers", "Utah Jazz"] },
  Pacific: { conf: "West", teams: ["Golden State Warriors", "Los Angeles Clippers", "Los Angeles Lakers", "Phoenix Suns", "Sacramento Kings"] },
  Southwest: { conf: "West", teams: ["Dallas Mavericks", "Houston Rockets", "Memphis Grizzlies", "New Orleans Pelicans", "San Antonio Spurs"] },
};
export const TEAM_INFO: Record<string, { conf: "East" | "West"; div: string }> = {};
for (const [div, d] of Object.entries(DIVISIONS)) for (const t of d.teams) TEAM_INFO[t] = { conf: d.conf, div };

export type SimGame = { home: string; away: string; w: number; result?: "home" | "away"; hFat?: number; aFat?: number };

// Otteluohjelma: oikea (jos kauden ottelut on haettu), muuten NBA:n rakenteen mukainen
// painotettu ohjelma: divisioona 4 peliä, muu konferenssi 3.6 (keskimäärin), toinen konferenssi 2
// — yhteensä 82, puolet kotona.
export function buildSchedule(
  games: { date: string; home: string; away: string; home_score: number | null; away_score: number | null; season_type?: string }[],
  seasonStart: string,
  fatigue = { b2b: 2, threeInFour: 1.5 }
) {
  const season = games.filter((g) => g.season_type !== "pre" && g.date >= seasonStart && TEAM_INFO[g.home] && TEAM_INFO[g.away]);
  if (season.length >= 1150) {
    // Väsymys oikeasta ohjelmasta: B2B = pelasi edellisenä päivänä, 3 peliä / 4 pv = kaksi peliä
    // kolmen edellisen päivän aikana (ei lasketa yhteen B2B:n kanssa) — sama sääntö kuin Matchupissa.
    const dayNum = (d: string) => Math.round(Date.parse(d + "T00:00:00Z") / 86400000);
    const byTeam = new Map<string, Set<number>>();
    for (const g of season) {
      for (const t of [g.home, g.away]) (byTeam.get(t) ?? byTeam.set(t, new Set()).get(t)!).add(dayNum(g.date));
    }
    const fat = (team: string, day: number) => {
      const set = byTeam.get(team)!;
      if (set.has(day - 1)) return fatigue.b2b;
      const n = [1, 2, 3].filter((k) => set.has(day - k)).length;
      return n >= 2 ? fatigue.threeInFour : 0;
    };
    let b2bCount = 0;
    const b2bByTeam: Record<string, number> = {};
    const out = season.map((g) => {
      const day = dayNum(g.date);
      const hFat = fat(g.home, day);
      const aFat = fat(g.away, day);
      if (hFat === fatigue.b2b && fatigue.b2b > 0) { b2bCount++; b2bByTeam[g.home] = (b2bByTeam[g.home] ?? 0) + 1; }
      if (aFat === fatigue.b2b && fatigue.b2b > 0) { b2bCount++; b2bByTeam[g.away] = (b2bByTeam[g.away] ?? 0) + 1; }
      return {
        home: g.home,
        away: g.away,
        w: 1,
        hFat,
        aFat,
        result: g.home_score != null && g.away_score != null ? (g.home_score > g.away_score ? "home" : "away") : undefined,
      } as SimGame;
    });
    // NBA julkaisee 1200 ottelua; loput 30 (2 / joukkue) päätetään NBA Cupin alkulohkon jälkeen.
    // Täydennetään puuttuvat pelit painotettuina otteluina joukkueiden välillä, joilta pelejä puuttuu,
    // jotta jokainen pelaa 82 (muuten kaikkien voitot jäävät ~1 alakanttiin).
    const count: Record<string, number> = {};
    for (const g of out) { count[g.home] = (count[g.home] ?? 0) + 1; count[g.away] = (count[g.away] ?? 0) + 1; }
    const teams = Object.keys(TEAM_INFO);
    const need = teams.map((t) => Math.max(0, 82 - (count[t] ?? 0)));
    let filled = 0;
    if (need.some((d) => d > 0) && out.length < 1230) {
      const x: number[] = need.map((d) => (d > 0 ? 1 : 0));
      for (let it = 0; it < 200; it++) {
        const sum = x.reduce((a, v) => a + v, 0);
        for (let i = 0; i < x.length; i++) if (need[i] > 0) x[i] = Math.sqrt(x[i] * (need[i] / Math.max(1e-9, sum - x[i]))); // vaimennettu (muuten värähtelee)
      }
      for (let i = 0; i < teams.length; i++)
        for (let j = i + 1; j < teams.length; j++) {
          const w = x[i] * x[j];
          if (w < 1e-4) continue;
          out.push({ home: teams[i], away: teams[j], w: w / 2 }, { home: teams[j], away: teams[i], w: w / 2 });
          filled += w;
        }
    }
    return { real: true, games: out, b2bCount, b2bByTeam, played: out.filter((g) => g.result).length, filled: Math.round(filled), realCount: season.length };
  }
  const teams = Object.keys(TEAM_INFO);
  const out: SimGame[] = [];
  for (let i = 0; i < teams.length; i++)
    for (let j = i + 1; j < teams.length; j++) {
      const a = TEAM_INFO[teams[i]], b = TEAM_INFO[teams[j]];
      const n = a.div === b.div ? 4 : a.conf === b.conf ? 3.6 : 2;
      out.push({ home: teams[i], away: teams[j], w: n / 2 }, { home: teams[j], away: teams[i], w: n / 2 });
    }
  return { real: false, games: out, b2bCount: 0, b2bByTeam: {} as Record<string, number>, played: 0, filled: 0, realCount: 0 };
}

export type TeamInput = {
  team: string;
  net: number; // kauden alun Net (liigakeskiarvoon nähden tai absoluuttinen — vain erot merkitsevät)
  pace: number;
  hca: number;
  newShare: number; // uusien pelaajien osuus minuuteista (0–1)
  sdOverride?: number; // käsin asetettu joukkueen tason epävarmuus (Net-hajonta), ohittaa automaattisen
  stars: { name: string; loss: number; missMean: number }[]; // loss = Net-pudotus kun poissa
};

// Joukkuekohtaiset varianssitekijät pelaajadatasta.
export function teamInputs(
  teams: { team: string; net: number; pace: number; hca: number }[],
  players: { team: string; name: string; oepm: number; depm: number; mpg_base: number; active: boolean }[],
  prevRows: PrevRow[],
  playerCarry: number, // 0–1, sama pelaajakerroin kuin lähtötasossa
  replacementEpm = -1.5
): TeamInput[] {
  const gp = new Map<string, { gp: number; teams: Set<string> }>();
  for (const r of prevRows) {
    const k = normalizePlayerName(r.name);
    const cur = gp.get(k) ?? { gp: 0, teams: new Set<string>() };
    cur.gp += Number(r.gp) || 0;
    cur.teams.add(r.team);
    gp.set(k, cur);
  }
  return teams.map((t) => {
    const roster = players.filter((p) => canonTeam(p.team) === t.team && p.active && p.mpg_base > 0);
    const tot = roster.reduce((a, p) => a + p.mpg_base, 0) || 1;
    const scale = 240 / tot;
    let newMin = 0;
    const contrib = roster.map((p) => {
      const prev = gp.get(normalizePlayerName(p.name));
      if (!prev || !prev.teams.has(t.team)) newMin += p.mpg_base;
      const min = p.mpg_base * scale;
      const loss = ((p.oepm + p.depm - replacementEpm) * min / 48) * playerCarry;
      // odotettu poissaolo-osuus: puolet viime kauden poissaoloista + puolet liigan keskiarvosta (~12 %)
      const g = prev ? prev.gp : 70;
      const missMean = Math.min(0.35, Math.max(0.05, 0.5 * (1 - Math.min(82, g) / 82) + 0.5 * 0.12));
      return { name: p.name, loss, missMean };
    });
    contrib.sort((a, b) => b.loss - a.loss);
    return { ...t, newShare: newMin / tot, stars: contrib.slice(0, 3).filter((s) => s.loss > 0.3) };
  });
}

function randn(): number {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
function normCdf(x: number): number {
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
// Beta-jakauma keskiarvolla m ja "tiheydellä" k (gamma-arvonnoin).
function randGamma(a: number): number {
  if (a < 1) return randGamma(a + 1) * Math.pow(Math.random(), 1 / a);
  const d = a - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x = 0, v = 0;
    do {
      x = randn();
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = Math.random();
    if (u < 1 - 0.0331 * x ** 4 || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}
function randBeta(m: number, k: number): number {
  const a = randGamma(m * k), b = randGamma((1 - m) * k);
  return a / (a + b);
}

export type SimOptions = { sims: number; baseSd: number; turnoverSd: number; injuryConc: number; gameSd: number };
export type SimResult = {
  team: string;
  conf: "East" | "West";
  net: number;
  injuryMean: number; // odotettu Net-menetys poissaoloista
  sd: number; // joukkueen tason epävarmuus ilman loukkaantumisia
  meanWins: number;
  p10: number;
  p50: number;
  p90: number;
  pTop6: number;
  pPlayIn: number; // sijat 7–10
  pPlayoffs: number; // pudotuspeleihin (play-in mukaan lukien)
  pSeed1: number;
  winDist: number[]; // voittojen jakauma 0..82
};

export function autoSd(t: TeamInput, opt: { baseSd: number; turnoverSd: number }): number {
  return Math.sqrt(opt.baseSd ** 2 + (opt.turnoverSd * t.newShare) ** 2);
}

export function simulateSeason(inputs: TeamInput[], schedule: SimGame[], opt: SimOptions): SimResult[] {
  const idx = new Map(inputs.map((t, i) => [t.team, i]));
  const n = inputs.length;
  const LP = inputs.reduce((a, t) => a + t.pace, 0) / n;
  const games = schedule.filter((g) => idx.has(g.home) && idx.has(g.away)).map((g) => ({ h: idx.get(g.home)!, a: idx.get(g.away)!, w: g.w, result: g.result, fat: (g.aFat ?? 0) - (g.hFat ?? 0) }));
  const acc = inputs.map(() => ({ wins: new Float64Array(83), sumW: 0, top6: 0, pin: 0, po: 0, s1: 0, winsList: [] as number[] }));
  const sdTeam = inputs.map((t) => t.sdOverride ?? autoSd(t, opt));
  const injMean = inputs.map((t) => t.stars.reduce((a, s) => a + s.loss * s.missMean, 0));
  const strength = new Float64Array(n);
  const wins = new Float64Array(n);
  for (let s = 0; s < opt.sims; s++) {
    for (let i = 0; i < n; i++) {
      const t = inputs[i];
      let inj = 0;
      for (const st of t.stars) inj += st.loss * randBeta(st.missMean, opt.injuryConc);
      strength[i] = t.net + sdTeam[i] * randn() - inj;
      wins[i] = 0;
    }
    for (const g of games) {
      if (g.result) {
        if (g.result === "home") wins[g.h] += g.w;
        else wins[g.a] += g.w;
        continue;
      }
      const pace = inputs[g.h].pace + inputs[g.a].pace - LP;
      const margin = (strength[g.h] - strength[g.a]) * (pace / 100) + inputs[g.h].hca + g.fat;
      const p = normCdf(margin / opt.gameSd);
      // painotettu ohjelma: w peliä -> binomiaalinen arvio
      if (g.w === 1) {
        if (Math.random() < p) wins[g.h] += 1;
        else wins[g.a] += 1;
      } else {
        const k = Math.max(1, Math.round(g.w));
        let hw = 0;
        for (let j = 0; j < k; j++) if (Math.random() < p) hw++;
        const f = g.w / k;
        wins[g.h] += hw * f;
        wins[g.a] += (k - hw) * f;
      }
    }
    // sijoitukset konferensseittain (tasatilanteet satunnaisesti)
    for (const conf of ["East", "West"] as const) {
      const ids = inputs.map((t, i) => i).filter((i) => TEAM_INFO[inputs[i].team]?.conf === conf);
      ids.sort((a, b) => wins[b] - wins[a] || Math.random() - 0.5);
      ids.forEach((i, rank) => {
        if (rank < 6) acc[i].top6++;
        else if (rank < 10) acc[i].pin++;
        if (rank === 0) acc[i].s1++;
      });
      const seeds = ids.slice(0, 10);
      for (let r = 0; r < 6; r++) acc[seeds[r]].po++;
      if (seeds.length >= 10) {
        const game = (h: number, a: number) => {
          const pace = inputs[h].pace + inputs[a].pace - LP;
          const m = (strength[h] - strength[a]) * (pace / 100) + inputs[h].hca;
          return Math.random() < normCdf(m / opt.gameSd) ? h : a;
        };
        const w78 = game(seeds[6], seeds[7]);
        const l78 = w78 === seeds[6] ? seeds[7] : seeds[6];
        const w910 = game(seeds[8], seeds[9]);
        const eighth = game(l78, w910);
        acc[w78].po++;
        acc[eighth].po++;
      }
    }
    for (let i = 0; i < n; i++) {
      acc[i].sumW += wins[i];
      acc[i].wins[Math.max(0, Math.min(82, Math.round(wins[i])))]++;
      acc[i].winsList.push(wins[i]);
    }
  }
  return inputs.map((t, i) => {
    const a = acc[i];
    const sorted = a.winsList.sort((x, y) => x - y);
    const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
    return {
      team: t.team,
      conf: TEAM_INFO[t.team]?.conf ?? "East",
      net: t.net,
      injuryMean: injMean[i],
      sd: sdTeam[i],
      meanWins: a.sumW / opt.sims,
      p10: q(0.1),
      p50: q(0.5),
      p90: q(0.9),
      pTop6: a.top6 / opt.sims,
      pPlayIn: a.pin / opt.sims,
      pPlayoffs: a.po / opt.sims,
      pSeed1: a.s1 / opt.sims,
      winDist: Array.from(a.wins, (x) => x / opt.sims),
    };
  });
}

// P(voitot > raja) jakaumasta (raja esim. 44.5)
export function pOver(r: SimResult, line: number): number {
  let p = 0;
  r.winDist.forEach((x, w) => {
    if (w > line) p += x;
  });
  return p;
}

// Markkinan win totaleista johdettu "terve" Net jokaiselle joukkueelle: haetaan iteroimalla
// Net, jolla simuloitu voittokeskiarvo osuu win total -rajaan samalla ohjelmalla,
// kotiedulla, väsymyksellä ja loukkaantumisilla kuin mallissa.
export function marketNets(inputs: TeamInput[], schedule: SimGame[], lines: Record<string, number>, opt: SimOptions): Record<string, number> {
  const cur = inputs.map((t) => {
    const inj = t.stars.reduce((a, st) => a + st.loss * st.missMean, 0);
    const line = lines[t.team];
    return { ...t, net: line != null ? (line - 41) / 2.7 + inj : t.net };
  });
  for (let it = 0; it < 5; it++) {
    const res = simulateSeason(cur, schedule, { ...opt, sims: it < 3 ? 1500 : 3000 });
    res.forEach((r, i) => {
      const line = lines[r.team];
      if (line != null) cur[i].net += (line - r.meanWins) / 2.7;
    });
  }
  const out: Record<string, number> = {};
  for (const t of cur) if (lines[t.team] != null) out[t.team] = t.net;
  return out;
}
