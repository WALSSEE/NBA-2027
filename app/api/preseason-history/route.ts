import { NextResponse } from "next/server";
import { fetchPreseasonHistory, type HistGame } from "@/lib/scheduleFetch";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Harjoituspelien taso vs. runkosarjan 3 ensimmäistä viikkoa, kausittain ja yhteensä.
// ?seasons=2023,2024,2025 (kauden alkuvuodet). Vain lukee ESPN:ää, ei kirjoita mitään.
function summarize(gs: HistGame[]) {
  const n = gs.length;
  const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null);
  const tot = gs.map((g) => g.home_score + g.away_score);
  const paces = gs.map((g) => g.pace).filter((x): x is number => x != null);
  const homeGames = gs.filter((g) => !g.neutral);
  const margins = homeGames.map((g) => g.home_score - g.away_score);
  const m = mean(margins);
  const sd = margins.length > 1 && m != null ? Math.sqrt(margins.reduce((a, x) => a + (x - m) ** 2, 0) / (margins.length - 1)) : null;
  return {
    n,
    total: mean(tot),
    pace: mean(paces),
    nPace: paces.length,
    nHome: homeGames.length,
    nNeutral: n - homeGames.length,
    homeMargin: m,
    homeMarginSe: sd != null ? sd / Math.sqrt(margins.length) : null,
  };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const seasons = (url.searchParams.get("seasons") ?? "2023,2024,2025")
    .split(",")
    .map(Number)
    .filter((y) => y >= 2015 && y <= 2030)
    .slice(0, 4);
  try {
    const games = await fetchPreseasonHistory(seasons, url.searchParams.get("pace") !== "0");
    const bySeason = seasons.map((s) => ({
      season: s,
      pre: summarize(games.filter((g) => g.season === s && g.type === "pre")),
      reg: summarize(games.filter((g) => g.season === s && g.type === "reg")),
    }));
    // Yhteenveto: kausien erotusten keskiarvo (kukin kausi verrataan omaan runkosarjaansa).
    const ok = bySeason.filter((b) => b.pre.n >= 10 && b.reg.n >= 10 && b.pre.total != null && b.reg.total != null);
    const avg = (f: (b: (typeof bySeason)[number]) => number | null) => {
      const xs = ok.map(f).filter((x): x is number => x != null);
      return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : null;
    };
    return NextResponse.json(
      {
        seasons: bySeason,
        totalDiff: avg((b) => b.pre.total! - b.reg.total!),
        paceDiff: avg((b) => (b.pre.pace != null && b.reg.pace != null ? b.pre.pace - b.reg.pace : null)),
        preHomeMargin: avg((b) => b.pre.homeMargin),
        regHomeMargin: avg((b) => b.reg.homeMargin),
        nSeasons: ok.length,
      },
      { headers: { "Cache-Control": "public, s-maxage=86400" } }
    );
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? String(e) }, { status: 500 });
  }
}
