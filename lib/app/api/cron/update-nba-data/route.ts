import { NextResponse } from "next/server";
import { fetchLeagueGameLog, fetchBoxScoreAdvanced } from "@/lib/nbaStats";
import { normalizeTeamName } from "@/lib/teamNames";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // Vercelin sallima maksimi Hobby-tasolla on pienempi, ks. README

const SEASON = process.env.NBA_SEASON ?? "2026-27";

// Vercel Cron kutsuu tätä GET-pyynnöllä secretilla varmistettuna (ks. vercel.json + README).
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();
  const log: string[] = [];

  try {
    const games = await fetchLeagueGameLog(SEASON);
    const gameIds = [...new Set(games.map((g: any) => g.GAME_ID))];
    log.push(`Löytyi ${gameIds.length} pelattua ottelua kaudelta ${SEASON}.`);

    // Katsotaan mitkä pelit on jo täydennetty tilastoilla, jotta ei tehdä turhia
    // pyyntöjä joka ajolla samoille vanhoille peleille.
    const { data: existing } = await supabase
      .from("schedule")
      .select("game_id")
      .not("home_ortg", "is", null);
    const alreadyDone = new Set((existing ?? []).map((r: any) => r.game_id));

    const newGameIds = gameIds.filter((id) => !alreadyDone.has(id));
    log.push(`Näistä ${newGameIds.length} vailla tilastoja — haetaan.`);

    let updated = 0;
    for (const gameId of newGameIds) {
      try {
        const teamStats = await fetchBoxScoreAdvanced(gameId as string);
        if (teamStats.length !== 2) continue;
        const [t1, t2] = teamStats;
        const gameRow = games.find((g: any) => g.GAME_ID === gameId && g.MATCHUP?.includes("vs."));
        const homeAbbr = gameRow ? gameRow.TEAM_ABBREVIATION : t1.TEAM_ABBREVIATION;
        const home = normalizeTeamName(homeAbbr);
        const homeStat = t1.TEAM_ABBREVIATION === homeAbbr ? t1 : t2;
        const awayStat = homeStat === t1 ? t2 : t1;
        const away = normalizeTeamName(awayStat.TEAM_ABBREVIATION);

        await supabase.from("schedule").upsert(
          {
            game_id: gameId,
            date: gameRow?.GAME_DATE ?? new Date().toISOString().slice(0, 10),
            home,
            away,
            home_ortg: homeStat.OFF_RATING,
            home_drtg: homeStat.DEF_RATING,
            home_pace: homeStat.PACE,
            away_ortg: awayStat.OFF_RATING,
            away_drtg: awayStat.DEF_RATING,
            away_pace: awayStat.PACE,
          },
          { onConflict: "game_id" }
        );
        updated += 1;
        // Kohtelias tauko NBA:n rajapinnalle ettei tule rate-limitattua
        await new Promise((r) => setTimeout(r, 600));
      } catch (err: any) {
        log.push(`Ohitettu peli ${gameId}: ${err.message}`);
      }
    }

    log.push(`Päivitetty ${updated} ottelun tilastot tietokantaan.`);
    return NextResponse.json({ ok: true, log });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message, log }, { status: 500 });
  }
}
