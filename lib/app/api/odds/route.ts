import { NextResponse } from "next/server";
import { normalizeOddsApi } from "@/lib/odds";

export const dynamic = "force-dynamic";

// NBA-kertoimet The Odds API:sta. Avain on vain palvelimella (ODDS_API_KEY).
// Vastaus välimuistiin 10 minuutiksi krediittien säästämiseksi (?refresh=1 ohittaa).
let cache: { at: number; body: any } | null = null;
const TTL = 10 * 60 * 1000;

export async function GET(request: Request) {
  const key = process.env.ODDS_API_KEY;
  if (!key) {
    return NextResponse.json({ error: "ODDS_API_KEY puuttuu Vercelin ympäristömuuttujista." }, { status: 500 });
  }
  const refresh = new URL(request.url).searchParams.get("refresh") === "1";
  if (cache && !refresh && Date.now() - cache.at < TTL) return NextResponse.json({ ...cache.body, cached: true });

  const regions = process.env.ODDS_API_REGIONS || "eu";
  const url =
    `https://api.the-odds-api.com/v4/sports/basketball_nba/odds?regions=${encodeURIComponent(regions)}` +
    `&markets=h2h,spreads,totals&oddsFormat=decimal&dateFormat=iso&apiKey=${encodeURIComponent(key)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const text = await res.text();
    if (!res.ok) {
      let msg = text;
      try {
        msg = JSON.parse(text).message ?? text;
      } catch {}
      return NextResponse.json({ error: `The Odds API ${res.status}: ${msg}` }, { status: 502 });
    }
    const events = normalizeOddsApi(JSON.parse(text));
    const body = {
      events,
      fetchedAt: new Date().toISOString(),
      remaining: res.headers.get("x-requests-remaining"),
      used: res.headers.get("x-requests-used"),
    };
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch (e: any) {
    return NextResponse.json({ error: `Kertoimien haku epäonnistui: ${e?.message ?? e}` }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
