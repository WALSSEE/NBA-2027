import { NextResponse } from "next/server";
import { nbaStatsFetch, resultSetToObjects } from "@/lib/nbaStats";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";
import { PREV_SEASON } from "@/lib/prevSeason";
import { replaceSeasonRows } from "@/lib/prevSeasonDb";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Hakee NBA:n pelaajakohtaiset pelilokit viime kaudelta ja laskee jokaiselle
// pelaaja–joukkue-parille pelit ja kokonaisminuutit. Tallentaa ne
// prev_season_minutes-tauluun (korvaa kauden rivit).
export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  let logs: any[];
  try {
    const url = `https://stats.nba.com/stats/leaguegamelog?Counter=0&DateFrom=&DateTo=&Direction=ASC&LeagueID=00&PlayerOrTeam=P&Season=${PREV_SEASON}&SeasonType=Regular%20Season&Sorter=DATE`;
    const data = await nbaStatsFetch(url);
    const rs = data?.resultSets?.[0];
    if (!rs?.headers || !rs?.rowSet) {
      return NextResponse.json({ error: "NBA:n vastauksen muoto oli odottamaton.", rawSample: JSON.stringify(data).slice(0, 1500) }, { status: 502 });
    }
    logs = resultSetToObjects(rs);
  } catch (e: any) {
    return NextResponse.json(
      { error: `NBA:n haku epäonnistui (${e?.message ?? e}). Käytä Basketball-Reference-liitettä.` },
      { status: 502 }
    );
  }

  const agg = new Map<string, { team: string; name: string; nba_id: number; gp: number; min_total: number }>();
  let unknownTeam = 0;
  for (const g of logs) {
    const team = TEAM_NAME_BY_ABBR[g.TEAM_ABBREVIATION];
    if (!team) {
      unknownTeam += 1;
      continue;
    }
    const min = Number(g.MIN) || 0;
    const key = `${g.PLAYER_ID}::${team}`;
    const cur = agg.get(key) ?? { team, name: g.PLAYER_NAME, nba_id: Number(g.PLAYER_ID), gp: 0, min_total: 0 };
    if (min > 0) cur.gp += 1;
    cur.min_total += min;
    agg.set(key, cur);
  }
  const rows = [...agg.values()].filter((r) => r.min_total > 0);
  if (rows.length === 0) {
    return NextResponse.json({ error: `NBA palautti ${logs.length} riviä, mutta niistä ei saatu minuutteja.` }, { status: 502 });
  }
  const res = await replaceSeasonRows(rows);
  if (res.error) return NextResponse.json({ error: res.error }, { status: 500 });
  return NextResponse.json({ ok: true, logs: logs.length, count: res.count, unknownTeam });
}
