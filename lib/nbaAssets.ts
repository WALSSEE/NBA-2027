// NBA:n viralliset joukkue-ID:t (samat kuin stats.nba.com / cdn.nba.com).
// Käytetään logojen hakemiseen NBA:n CDN:stä.
export const TEAM_ID_BY_NAME: Record<string, number> = {
  "Atlanta Hawks": 1610612737,
  "Boston Celtics": 1610612738,
  "Cleveland Cavaliers": 1610612739,
  "New Orleans Pelicans": 1610612740,
  "Chicago Bulls": 1610612741,
  "Dallas Mavericks": 1610612742,
  "Denver Nuggets": 1610612743,
  "Golden State Warriors": 1610612744,
  "Houston Rockets": 1610612745,
  "Los Angeles Clippers": 1610612746,
  "Los Angeles Lakers": 1610612747,
  "Miami Heat": 1610612748,
  "Milwaukee Bucks": 1610612749,
  "Minnesota Timberwolves": 1610612750,
  "Brooklyn Nets": 1610612751,
  "New York Knicks": 1610612752,
  "Orlando Magic": 1610612753,
  "Indiana Pacers": 1610612754,
  "Philadelphia 76ers": 1610612755,
  "Phoenix Suns": 1610612756,
  "Portland Trail Blazers": 1610612757,
  "Sacramento Kings": 1610612758,
  "San Antonio Spurs": 1610612759,
  "Oklahoma City Thunder": 1610612760,
  "Toronto Raptors": 1610612761,
  "Utah Jazz": 1610612762,
  "Memphis Grizzlies": 1610612763,
  "Washington Wizards": 1610612764,
  "Detroit Pistons": 1610612765,
  "Charlotte Hornets": 1610612766,
};

export function teamLogoUrl(team: string): string | null {
  const id = TEAM_ID_BY_NAME[team];
  return id ? `https://cdn.nba.com/logos/nba/${id}/global/L/logo.svg` : null;
}

export function headshotUrl(nbaId: number | null | undefined, url?: string | null): string | null {
  if (url) return url;
  return nbaId ? `https://cdn.nba.com/headshots/nba/latest/260x190/${nbaId}.png` : null;
}

export function initials(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export function lastName(name: string): string {
  const parts = name.split(/\s+/).filter(Boolean);
  const suffix = /^(jr\.?|sr\.?|ii|iii|iv)$/i;
  while (parts.length > 1 && suffix.test(parts[parts.length - 1])) parts.pop();
  return parts[parts.length - 1] ?? name;
}
