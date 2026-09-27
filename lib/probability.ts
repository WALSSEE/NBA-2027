// Normaalijakauman kertymäfunktio (Abramowitz & Stegun 7.1.26, virhe < 1.5e-7).
export function normCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

// Ottelun todennäköisyydet mallin ennusteesta, olettaen että lopputulos
// jakautuu normaalisti ennusteen ympärille.
//  - margin = koti − vieras (ennuste), marginSd = hajonta pisteinä
//  - total  = yhteispisteet (ennuste), totalSd = hajonta pisteinä
//  - spreadLine = kotijoukkueen tasoitus vedonlyöntimuodossa (esim. −4.5)
//  - totalLine = over/under-raja (esim. 226.5)
export function gameProbabilities(opts: {
  margin: number;
  total: number;
  marginSd: number;
  totalSd: number;
  spreadLine: number | null;
  totalLine: number | null;
}) {
  const { margin, total, marginSd, totalSd, spreadLine, totalLine } = opts;
  const homeWin = normCdf(margin / marginSd);
  const homeCover = spreadLine == null ? null : normCdf((margin + spreadLine) / marginSd);
  const over = totalLine == null ? null : 1 - normCdf((totalLine - total) / totalSd);
  return {
    homeWin,
    awayWin: 1 - homeWin,
    homeCover,
    awayCover: homeCover == null ? null : 1 - homeCover,
    over,
    under: over == null ? null : 1 - over,
  };
}

export function fairOdds(p: number | null): string {
  if (p == null || p <= 0) return "—";
  return (1 / p).toFixed(2);
}

export function pct(p: number | null): string {
  if (p == null) return "—";
  return `${(p * 100).toFixed(1)} %`;
}
