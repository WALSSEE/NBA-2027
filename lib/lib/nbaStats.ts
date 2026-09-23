// Palvelinpuolen fetch-wrapper stats.nba.com:ia varten.
// Tätä ajetaan Vercel-funktiossa (Node-ympäristö), ei selaimessa —
// CORS koskee vain selaimen tekemiä pyyntöjä, joten tämä toimii
// vaikka sama pyyntö epäonnistuisi suoraan artifaktin/selaimen puolelta.

const NBA_HEADERS: Record<string, string> = {
  Host: "stats.nba.com",
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "x-nba-stats-origin": "stats",
  "x-nba-stats-token": "true",
  Connection: "keep-alive",
  Referer: "https://www.nba.com/",
  "Cache-Control": "no-cache",
};

export async function nbaStatsFetch(url: string): Promise<any> {
  const res = await fetch(url, { headers: NBA_HEADERS, cache: "no-store" });
  if (!res.ok) {
    throw new Error(`stats.nba.com vastasi ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

// Muuntaa NBA:n rajapinnan "resultSets"-muodon (headers+rowSet) taulukoksi objekteja.
export function resultSetToObjects(resultSet: { headers: string[]; rowSet: any[][] }) {
  return resultSet.rowSet.map((row) =>
    Object.fromEntries(row.map((val, i) => [resultSet.headers[i], val]))
  );
}

export async function fetchLeagueGameLog(season: string) {
  const url = `https://stats.nba.com/stats/leaguegamelog?Counter=1000&Season=${season}&SeasonType=Regular+Season&LeagueID=00&PlayerOrTeam=T&Direction=DESC&Sorter=DATE`;
  const data = await nbaStatsFetch(url);
  return resultSetToObjects(data.resultSets[0]);
}

export async function fetchBoxScoreAdvanced(gameId: string) {
  const url = `https://stats.nba.com/stats/boxscoreadvancedv2?GameID=${gameId}&StartPeriod=0&EndPeriod=10&StartRange=0&EndRange=28800&RangeType=0`;
  const data = await nbaStatsFetch(url);
  // resultSets[1] = TeamStats (kaksi riviä: koti + vieras)
  return resultSetToObjects(data.resultSets[1]);
}

export async function fetchScheduleV2(season: string) {
  const url = `https://stats.nba.com/stats/scheduleleaguev2?LeagueID=00&Season=${season}`;
  const data = await nbaStatsFetch(url);
  return data;
}
