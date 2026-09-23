import { NextResponse } from "next/server";
import { fetchScheduleV2 } from "@/lib/nbaStats";
import { normalizeTeamName } from "@/lib/teamNames";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const SEASON = process.env.NBA_SEASON ?? "2026-27";

// Tätä kannattaa ajaa harvoin (esim. kerran viikossa) — otteluohjelma ei
// muutu usein, vain silloin kun ottelu siirretään tai NBA TV-syistä vaihtaa aikaa.
export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const supabase = getSupabaseAdmin();

  try {
    const raw = await fetchScheduleV2(SEASON);

    // HUOM: en ole päässyt testaamaan tätä oikealla NBA-datalla (verkkorajoitus
    // kehitysympäristössä). scheduleleaguev2-rajapinnan tarkka rakenne saattaa
    // poiketa tästä oletuksesta — jos tämä epäonnistuu, palauta raakavastaus
    // (ks. catch-lohko alla) ja säädetään parsinta sen mukaan.
    const gameDates = raw?.leagueSchedule?.gameDates ?? [];
    const rows: any[] = [];
    for (const gd of gameDates) {
      for (const game of gd.games ?? []) {
        rows.push({
          game_id: game.gameId,
          date: (game.gameDateEst ?? gd.gameDate ?? "").slice(0, 10),
          home: normalizeTeamName(game.homeTeam?.teamTricode),
          away: normalizeTeamName(game.awayTeam?.teamTricode),
        });
      }
    }

    if (rows.length === 0) {
      return NextResponse.json(
        {
          ok: false,
          error: "0 ottelua parsittu — rajapinnan muoto ei täsmännyt oletukseen.",
          rawSample: JSON.stringify(raw).slice(0, 2000),
        },
        { status: 500 }
      );
    }

    let upserted = 0;
    for (const row of rows) {
      await supabase.from("schedule").upsert(row, { onConflict: "game_id" });
      upserted += 1;
    }

    return NextResponse.json({ ok: true, upserted, total: rows.length });
  } catch (err: any) {
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
