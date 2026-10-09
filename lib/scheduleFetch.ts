import { TEAM_NAME_BY_ABBR } from "./teamNames";

export type SchedRow = { game_id: string; date: string; home: string; away: string; season_type: "reg" | "pre" };

// ESPN:n lyhenteet, jotka eroavat NBA:n omista.
const ESPN_ABBR: Record<string, string> = { GS: "GSW", NY: "NYK", SA: "SAS", NO: "NOP", UTAH: "UTA", WSH: "WAS", PHO: "PHX", BRK: "BKN" };
const teamOf = (abbr: string | undefined) => (abbr ? TEAM_NAME_BY_ABBR[ESPN_ABBR[abbr] ?? abbr] : undefined);

// Ottelupäivä USA:n itäisen ajan mukaan UTC-ajasta.
function usDate(iso: string): string {
  return new Date(new Date(iso).getTime() - 5 * 3600 * 1000).toISOString().slice(0, 10);
}

async function getJson(url: string, ms = 20000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store", headers: { "User-Agent": "Mozilla/5.0", Referer: "https://www.nba.com/" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// 1) NBA:n CDN:n staattinen koko kauden ohjelma (sama muoto kuin scheduleleaguev2).
export async function fetchScheduleCdn(): Promise<SchedRow[]> {
  const raw = await getJson("https://cdn.nba.com/static/json/staticData/scheduleLeagueV2.json");
  const rows: SchedRow[] = [];
  for (const gd of raw?.leagueSchedule?.gameDates ?? []) {
    for (const g of gd.games ?? []) {
      const id = String(g.gameId ?? "");
      // 002 = runkosarja (NBA Cupin alkulohko kuuluu siihen), 001 = harjoituskausi; muut (All-Star, play-in, pudotuspelit) pois
      const season_type = id.startsWith("002") ? "reg" : id.startsWith("001") ? "pre" : null;
      if (!season_type) continue;
      const home = teamOf(g.homeTeam?.teamTricode);
      const away = teamOf(g.awayTeam?.teamTricode);
      if (!home || !away) continue;
      const date = String(g.gameDateEst ?? gd.gameDate ?? "").slice(0, 10);
      rows.push({ game_id: id, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : usDate(g.gameDateTimeUTC), home, away, season_type });
    }
  }
  return rows;
}

// ESPN: season.type 1 = harjoituskausi, 2 = runkosarja, 3 = pudotuspelit, 5 = play-in.
// NBA Cupin finaali ei kuulu runkosarjan sarjataulukkoon (ESPN merkitsee sen tyypillä 2, mutta nimellä).
function isRegularSeason(ev: any): boolean {
  if (ev?.season?.type !== 2) return false;
  const note = JSON.stringify(ev?.competitions?.[0]?.notes ?? "").toLowerCase();
  if (note.includes("championship") && note.includes("cup")) return false;
  return true;
}

// 2) Varalla: ESPN:n päiväkohtainen scoreboard koko kaudelle (lokakuu–huhtikuu, ~190 hakua
//    rinnakkain). ESPN:n joukkuekohtainen ohjelma on usein vajaa, scoreboard on täydellinen.
export async function fetchScheduleEspn(seasonEndYear: number): Promise<SchedRow[]> {
  const days: string[] = [];
  const d = new Date(Date.UTC(seasonEndYear - 1, 8, 28)); // harjoituskausi alkaa lokakuun alussa
  const end = new Date(Date.UTC(seasonEndYear, 3, 20));
  for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  const byId = new Map<string, SchedRow>();
  for (let i = 0; i < days.length; i += 25) {
    const chunk = days.slice(i, i + 25);
    const res = await Promise.allSettled(
      chunk.map((day) => getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${day.replace(/-/g, "")}`, 15000).then((j) => ({ day, j })))
    );
    for (const r of res) {
      if (r.status !== "fulfilled") continue;
      for (const ev of r.value.j?.events ?? []) {
        const pre = ev?.season?.type === 1;
        if (!pre && !isRegularSeason(ev)) continue; // runkosarja + harjoituskausi (ei play-iniä, pudotuspelejä)
        const cs = ev.competitions?.[0]?.competitors ?? [];
        const h = cs.find((c: any) => c.homeAway === "home");
        const a = cs.find((c: any) => c.homeAway === "away");
        const home = teamOf(h?.team?.abbreviation);
        const away = teamOf(a?.team?.abbreviation);
        if (!home || !away) continue;
        byId.set(`espn-${ev.id}`, { game_id: `espn-${ev.id}`, date: r.value.day, home, away, season_type: pre ? "pre" : "reg" });
      }
    }
  }
  return [...byId.values()];
}

// ---------------------------------------------------------------------------
// Pelattujen otteluiden tulokset ja tehokkuus ESPN:stä (stats.nba.com ei vastaa Vercelille).
// Possessiot = FGA + 0.44·FTA − OREB + TOV (joukkueiden keskiarvo), tempo per 48 min.
export type GameResult = {
  espnId: string;
  date: string;
  home: string;
  away: string;
  home_score: number;
  away_score: number;
  home_ortg: number;
  home_drtg: number;
  away_ortg: number;
  away_drtg: number;
  pace: number;
};

function statOf(team: any, ...names: string[]): number | null {
  // nimet tärkeysjärjestyksessä (esim. totalTurnovers ennen turnovers)
  for (const nm of names) {
    for (const s of team?.statistics ?? []) {
      if (s.name === nm || s.abbreviation === nm) {
        const v = String(s.displayValue ?? "");
        const n = Number(v.includes("-") ? v.split("-")[0] : v);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}
function attempts(team: any, ...names: string[]): number | null {
  for (const s of team?.statistics ?? []) {
    if (names.includes(s.name) || names.includes(s.label)) {
      const v = String(s.displayValue ?? "");
      if (v.includes("-")) {
        const n = Number(v.split("-")[1]);
        if (Number.isFinite(n)) return n;
      }
    }
  }
  return null;
}

export async function fetchResultsForDate(date: string): Promise<GameResult[]> {
  const ymd = date.replace(/-/g, "");
  const sb = await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${ymd}`);
  const out: GameResult[] = [];
  for (const ev of sb?.events ?? []) {
    if (!isRegularSeason(ev)) continue;
    const comp = ev.competitions?.[0];
    if (!comp?.status?.type?.completed) continue;
    const cs = comp.competitors ?? [];
    const h = cs.find((c: any) => c.homeAway === "home");
    const a = cs.find((c: any) => c.homeAway === "away");
    const home = teamOf(h?.team?.abbreviation);
    const away = teamOf(a?.team?.abbreviation);
    if (!home || !away) continue;
    const hs = Number(h.score), as = Number(a.score);
    const periods = Math.max(4, (h.linescores ?? []).length);
    let box: any = null;
    try {
      box = await getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${ev.id}`, 15000);
    } catch {
      continue;
    }
    const bt = box?.boxscore?.teams ?? [];
    const bh = bt.find((t: any) => teamOf(t.team?.abbreviation) === home);
    const ba = bt.find((t: any) => teamOf(t.team?.abbreviation) === away);
    const poss = (t: any) => {
      const fga = attempts(t, "fieldGoalsMade-fieldGoalsAttempted", "FG");
      const fta = attempts(t, "freeThrowsMade-freeThrowsAttempted", "FT");
      const orb = statOf(t, "offensiveRebounds", "OR");
      const tov = statOf(t, "totalTurnovers", "turnovers", "TO");
      if (fga == null || fta == null || orb == null || tov == null) return null;
      return fga + 0.44 * fta - orb + tov;
    };
    const ph = poss(bh), pa = poss(ba);
    if (ph == null || pa == null) continue;
    const p = (ph + pa) / 2;
    out.push({
      espnId: String(ev.id),
      date,
      home,
      away,
      home_score: hs,
      away_score: as,
      home_ortg: (100 * hs) / p,
      home_drtg: (100 * as) / p,
      away_ortg: (100 * as) / p,
      away_drtg: (100 * hs) / p,
      pace: (p * 48) / (48 + 5 * (periods - 4)),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Harjoituskauden historia: harjoituspelien pisteet ja tempo verrattuna saman kauden
// runkosarjan kolmeen ensimmäiseen viikkoon. Vain NBA-joukkueiden väliset pelit.
export type HistGame = {
  season: number; // kauden alkuvuosi (2025 = 2025-26)
  type: "pre" | "reg";
  date: string;
  home: string;
  away: string;
  neutral: boolean;
  home_score: number;
  away_score: number;
  pace: number | null;
};

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<PromiseSettledResult<R>[]> {
  const out: PromiseSettledResult<R>[] = [];
  for (let i = 0; i < items.length; i += limit) {
    out.push(...(await Promise.allSettled(items.slice(i, i + limit).map(fn))));
  }
  return out;
}

export async function fetchPreseasonHistory(startYears: number[], withPace = true): Promise<HistGame[]> {
  const days: { season: number; day: string }[] = [];
  for (const y of startYears) {
    const d = new Date(Date.UTC(y, 8, 28));
    const end = new Date(Date.UTC(y, 10, 16));
    for (; d <= end; d.setUTCDate(d.getUTCDate() + 1)) days.push({ season: y, day: d.toISOString().slice(0, 10) });
  }
  const sb = await mapLimit(days, 30, (x) =>
    getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${x.day.replace(/-/g, "")}`, 15000).then((j) => ({ ...x, j }))
  );
  const games: (HistGame & { id: string })[] = [];
  for (const r of sb) {
    if (r.status !== "fulfilled") continue;
    for (const ev of r.value.j?.events ?? []) {
      const pre = ev?.season?.type === 1;
      if (!pre && !isRegularSeason(ev)) continue;
      const comp = ev.competitions?.[0];
      if (!comp?.status?.type?.completed) continue;
      const cs = comp.competitors ?? [];
      const h = cs.find((c: any) => c.homeAway === "home");
      const a = cs.find((c: any) => c.homeAway === "away");
      const home = teamOf(h?.team?.abbreviation);
      const away = teamOf(a?.team?.abbreviation);
      if (!home || !away) continue; // ulkomaiset seurat pois
      const hs = Number(h.score), as = Number(a.score);
      if (!Number.isFinite(hs) || !Number.isFinite(as) || hs + as < 100) continue;
      games.push({ id: String(ev.id), season: r.value.season, type: pre ? "pre" : "reg", date: r.value.day, home, away, neutral: !!comp.neutralSite, home_score: hs, away_score: as, pace: null });
    }
  }
  // Runkosarjasta vain kolme ensimmäistä viikkoa (vertailukohta samalta ajalta).
  const regStart: Record<number, string> = {};
  for (const g of games) if (g.type === "reg" && (!regStart[g.season] || g.date < regStart[g.season])) regStart[g.season] = g.date;
  const cut = (s: number) => {
    const d = new Date(regStart[s] + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + 21);
    return d.toISOString().slice(0, 10);
  };
  const uniq = new Map<string, HistGame & { id: string }>();
  for (const g of games) if (g.type === "pre" || (regStart[g.season] && g.date < cut(g.season))) uniq.set(g.id, g);
  const list = [...uniq.values()];
  if (withPace) {
    const boxes = await mapLimit(list, 30, (g) => getJson(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${g.id}`, 15000).then((b) => ({ g, b })));
    for (const r of boxes) {
      if (r.status !== "fulfilled") continue;
      const { g, b } = r.value;
      const bt = b?.boxscore?.teams ?? [];
      const poss = (t: any) => {
        const fga = attempts(t, "fieldGoalsMade-fieldGoalsAttempted", "FG");
        const fta = attempts(t, "freeThrowsMade-freeThrowsAttempted", "FT");
        const orb = statOf(t, "offensiveRebounds", "OR");
        const tov = statOf(t, "totalTurnovers", "turnovers", "TO");
        if (fga == null || fta == null || orb == null || tov == null) return null;
        return fga + 0.44 * fta - orb + tov;
      };
      const p = bt.map(poss).filter((x: number | null): x is number => x != null);
      const periods = Math.max(4, (b?.header?.competitions?.[0]?.competitors?.[0]?.linescores ?? []).length);
      if (p.length === 2) g.pace = (((p[0] + p[1]) / 2) * 48) / (48 + 5 * (periods - 4));
    }
  }
  return list.map(({ id, ...g }) => g);
}
