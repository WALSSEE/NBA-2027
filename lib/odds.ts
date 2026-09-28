import { canonTeam } from "./prevSeason";

// Yhden bookkerin linjat ottelulle (kotijoukkueen näkökulmasta).
export type BookLines = {
  key: string;
  title: string;
  ml?: { home: number; away: number };
  spread?: { point: number; home: number; away: number }; // point = kotijoukkueen tasoitus (esim. -4.5)
  total?: { point: number; over: number; under: number };
};
export type OddsEvent = { id: string; commence: string; home: string; away: string; books: BookLines[] };

const ALIAS: Record<string, string> = { "LA Clippers": "Los Angeles Clippers", "LA Lakers": "Los Angeles Lakers" };
export function oddsTeam(name: string): string {
  const n = ALIAS[name] ?? name;
  return canonTeam(n) ?? n;
}

// The Odds API v4 -vastauksen normalisointi.
export function normalizeOddsApi(raw: any[]): OddsEvent[] {
  return (raw ?? []).map((ev) => {
    const homeRaw = ev.home_team as string;
    const awayRaw = ev.away_team as string;
    const books: BookLines[] = (ev.bookmakers ?? []).map((bk: any) => {
      const out: BookLines = { key: bk.key, title: bk.title };
      for (const m of bk.markets ?? []) {
        const o = (name: string) => (m.outcomes ?? []).find((x: any) => x.name === name);
        if (m.key === "h2h") {
          const h = o(homeRaw), a = o(awayRaw);
          if (h && a) out.ml = { home: h.price, away: a.price };
        } else if (m.key === "spreads") {
          const h = o(homeRaw), a = o(awayRaw);
          if (h && a && typeof h.point === "number") out.spread = { point: h.point, home: h.price, away: a.price };
        } else if (m.key === "totals") {
          const ov = o("Over"), un = o("Under");
          if (ov && un && typeof ov.point === "number") out.total = { point: ov.point, over: ov.price, under: un.price };
        }
      }
      return out;
    });
    return { id: ev.id, commence: ev.commence_time, home: oddsTeam(homeRaw), away: oddsTeam(awayRaw), books };
  });
}

const median = (xs: number[]) => {
  if (xs.length === 0) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

// Yleisin linja; tasatilanteessa lähimpänä mediaania.
function commonPoint(pts: number[]): number {
  const cnt = new Map<number, number>();
  for (const p of pts) cnt.set(p, (cnt.get(p) ?? 0) + 1);
  const med = median(pts);
  return [...cnt.entries()].sort((a, b) => b[1] - a[1] || Math.abs(a[0] - med) - Math.abs(b[0] - med) || a[0] - b[0])[0][0];
}

// Konsensus: yleisin linja; hinnat niiden bookkerien mediaanina, joilla sama linja.
export function consensus(ev: OddsEvent): BookLines {
  const out: BookLines = { key: "consensus", title: "Konsensus" };
  const mls = ev.books.filter((b) => b.ml);
  if (mls.length) {
    // marginaaliton todennäköisyys -> reilu kerroin
    const ph = median(mls.map((b) => (1 / b.ml!.home) / (1 / b.ml!.home + 1 / b.ml!.away)));
    out.ml = { home: 1 / ph, away: 1 / (1 - ph) };
  }
  const sp = ev.books.filter((b) => b.spread);
  if (sp.length) {
    const pt = commonPoint(sp.map((b) => b.spread!.point));
    const same = sp.filter((b) => b.spread!.point === pt);
    const src = same.length ? same : sp;
    out.spread = { point: pt, home: median(src.map((b) => b.spread!.home)), away: median(src.map((b) => b.spread!.away)) };
  }
  const tt = ev.books.filter((b) => b.total);
  if (tt.length) {
    const pt = commonPoint(tt.map((b) => b.total!.point));
    const same = tt.filter((b) => b.total!.point === pt);
    const src = same.length ? same : tt;
    out.total = { point: pt, over: median(src.map((b) => b.total!.over)), under: median(src.map((b) => b.total!.under)) };
  }
  return out;
}

// Paras kerroin samalla linjalla kaikista bookkereista.
export function bestPrice(ev: OddsEvent, market: "spread-home" | "spread-away" | "over" | "under" | "ml-home" | "ml-away", point?: number) {
  let best: { price: number; book: string } | null = null;
  for (const b of ev.books) {
    let price: number | undefined;
    if (market === "ml-home") price = b.ml?.home;
    else if (market === "ml-away") price = b.ml?.away;
    else if (market === "spread-home" && b.spread?.point === point) price = b.spread.home;
    else if (market === "spread-away" && b.spread?.point === point) price = b.spread.away;
    else if (market === "over" && b.total?.point === point) price = b.total.over;
    else if (market === "under" && b.total?.point === point) price = b.total.under;
    if (price && (!best || price > best.price)) best = { price, book: b.title };
  }
  return best;
}

// Ottelupäivä USA:n itäisen ajan mukaan (sama kuin otteluohjelmassa).
export function usGameDate(iso: string): string {
  const d = new Date(new Date(iso).getTime() - 5 * 3600 * 1000);
  return d.toISOString().slice(0, 10);
}
