// NBA:n TEAM_ABBREVIATION -> täysi nimi, samat nimet joita appin
// Teams/Players-taulukoissa jo käytetään. Näin liittämisdatan ja
// automaattisen datan joukkuenimet täsmää aina, eikä synny duplikaattirivejä
// pelkän kirjoitusasu-eron takia (esim. "LA Clippers" vs "Los Angeles Clippers").
export const TEAM_NAME_BY_ABBR: Record<string, string> = {
  OKC: "Oklahoma City Thunder",
  BOS: "Boston Celtics",
  CHA: "Charlotte Hornets",
  NYK: "New York Knicks",
  DET: "Detroit Pistons",
  CLE: "Cleveland Cavaliers",
  SAS: "San Antonio Spurs",
  DEN: "Denver Nuggets",
  MIA: "Miami Heat",
  HOU: "Houston Rockets",
  LAL: "Los Angeles Lakers",
  LAC: "Los Angeles Clippers",
  ATL: "Atlanta Hawks",
  TOR: "Toronto Raptors",
  MIN: "Minnesota Timberwolves",
  POR: "Portland Trail Blazers",
  NOP: "New Orleans Pelicans",
  ORL: "Orlando Magic",
  PHX: "Phoenix Suns",
  GSW: "Golden State Warriors",
  IND: "Indiana Pacers",
  PHI: "Philadelphia 76ers",
  DAL: "Dallas Mavericks",
  CHI: "Chicago Bulls",
  SAC: "Sacramento Kings",
  MIL: "Milwaukee Bucks",
  BKN: "Brooklyn Nets",
  UTA: "Utah Jazz",
  MEM: "Memphis Grizzlies",
  WAS: "Washington Wizards",
};

export function normalizeTeamName(abbr: string): string {
  return TEAM_NAME_BY_ABBR[abbr] ?? abbr;
}
