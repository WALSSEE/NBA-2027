"use client";

import { useEffect, useMemo, useState } from "react";

type TeamStats = {
  id: string;
  team: string;
  pace_2425: number | null;
  ortg_2425: number | null;
  drtg_2425: number | null;
  pace_2526: number | null;
  ortg_2526: number | null;
  drtg_2526: number | null;
  coach_change: boolean | null;
  home_adv: number | null;
};

type Transaction = {
  id: string;
  team: string;
  date: string;
  delta_o: number | null;
  delta_d: number | null;
};

type Game = {
  id: string;
  date: string;
  home: string;
  away: string;
  home_ortg: number | null;
  home_drtg: number | null;
  home_pace: number | null;
  away_ortg: number | null;
  away_drtg: number | null;
  away_pace: number | null;
};

const LEAGUE_AVG_PACE = 100;

// EWMA-päivitys: uusi_rating = alpha * tuorein_peli + (1-alpha) * vanha_rating.
// Koska kaava on rekursiivinen, vanhat pelit eivät katoa vaan niiden paino
// laskee eksponentiaalisesti jokaisen uuden pelin myötä — viimeisin peli
// vaikuttaa aina hieman enemmän kuin edellinen. "prior" (kausiblendattu
// preseason-arvo) toimii lähtöpisteenä ennen 1. peliä, ja unohtuu itsestään
// sitä mukaa kun pelejä kertyy — ei tarvita erillistä siirtymälogiikkaa.
function ewma(prior: number, values: number[], alpha: number): number {
  let rating = prior;
  for (const v of values) {
    rating = alpha * v + (1 - alpha) * rating;
  }
  return rating;
}

export default function MatchupPage() {
  const [teams, setTeams] = useState<TeamStats[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");
  // blendWeight = paino uusimmalle (25-26) kaudelle, 0-100 (preseason-prior).
  const [blendWeight, setBlendWeight] = useState(50);
  // alpha = kuinka paljon paino yksi pelattu ottelu saa EWMA-päivityksessä.
  // 0.15 ~ "muisti" n. 1/0.15 ≈ 6-7 peliä.
  const [alpha, setAlpha] = useState(0.15);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [teamsRes, txRes, gamesRes] = await Promise.all([
          fetch("/api/team-stats"),
          fetch("/api/transactions"),
          fetch("/api/schedule"),
        ]);
        const teamsJson = await teamsRes.json();
        const txJson = await txRes.json();
        const gamesJson = await gamesRes.json();
        if (teamsJson.error) throw new Error(teamsJson.error);
        if (txJson.error) throw new Error(txJson.error);
        if (gamesJson.error) throw new Error(gamesJson.error);
        const t: TeamStats[] = teamsJson.teams ?? [];
        setTeams(t);
        setTransactions(txJson.transactions ?? []);
        setGames(gamesJson.games ?? []);
        if (t.length > 0) {
          setHomeTeam(t[0].team);
          setAwayTeam(t[1]?.team ?? t[0].team);
        }
      } catch (e: any) {
        setError(e.message ?? "Virhe datan haussa");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // Pelatut ottelut per joukkue, kronologisessa järjestyksessä (vanhin
  // ensin), joukkueen omasta näkökulmasta (koti- tai vierasottelu). Päivämäärä
  // säilytetään mukana, jotta voidaan laskea kuinka monta ottelua joukkue on
  // pelannut minkäkin treidin JÄLKEEN (ks. transactionNetFor alla).
  const gamesByTeam = useMemo(() => {
    const map: Record<string, { date: string; ortg: number; drtg: number; pace: number }[]> = {};
    for (const g of games) {
      if (g.home_ortg == null || g.away_ortg == null) continue; // ei vielä laskettu
      if (!map[g.home]) map[g.home] = [];
      map[g.home].push({ date: g.date, ortg: g.home_ortg, drtg: g.home_drtg ?? 0, pace: g.home_pace ?? LEAGUE_AVG_PACE });
      if (!map[g.away]) map[g.away] = [];
      map[g.away].push({ date: g.date, ortg: g.away_ortg, drtg: g.away_drtg ?? 0, pace: g.away_pace ?? LEAGUE_AVG_PACE });
    }
    return map;
  }, [games]);

  // Treidin nettovaikutus joukkueelle, PAINOTETTUNA samalla unohtamiskaavalla
  // kuin EWMA käyttää peleille: kerroin = (1-alpha)^(pelatut ottelut treidin
  // jälkeen). Tuore treidi (0 peliä pelattu sen jälkeen) -> kerroin 1, koko
  // delta näkyy. Sitä mukaa kun joukkue pelaa otteluita UUDELLA kokoon-
  // panolla, todellinen data (EWMA) alkaa jo itsessään heijastaa muutosta,
  // joten käsin lisätty delta kutistuu samaa tahtia -> ei lasketa kahteen
  // kertaan.
  function transactionNetFor(team: string): { o: number; d: number } {
    const teamGames = gamesByTeam[team] ?? [];
    let o = 0;
    let d = 0;
    for (const tx of transactions) {
      if (tx.team !== team) continue;
      const gamesSince = teamGames.filter((g) => g.date >= tx.date).length;
      const decay = Math.pow(1 - alpha, gamesSince);
      o += (tx.delta_o ?? 0) * decay;
      d += (tx.delta_d ?? 0) * decay;
    }
    return { o, d };
  }

  // Laskee joukkueen lopulliset ORTG/DRTG/Pace kolmessa vaiheessa:
  // 1) kausien blendaus (tai coach_change-ohitus) = preseason-prior
  // 2) EWMA-päivitys kaikilla tähän mennessä pelatuilla otteluilla —
  //    uusin peli painaa eniten, prior "unohtuu" itsestään pelien myötä
  // 3) transaktioiden (treidien) nettovaikutus lisätään päälle
  function finalStatsFor(team: TeamStats | undefined) {
    if (!team) return null;
    const w = team.coach_change ? 1 : blendWeight / 100;
    const ortgBlend =
      (team.ortg_2526 ?? team.ortg_2425 ?? LEAGUE_AVG_PACE) * w +
      (team.ortg_2425 ?? team.ortg_2526 ?? LEAGUE_AVG_PACE) * (1 - w);
    const drtgBlend =
      (team.drtg_2526 ?? team.drtg_2425 ?? LEAGUE_AVG_PACE) * w +
      (team.drtg_2425 ?? team.drtg_2526 ?? LEAGUE_AVG_PACE) * (1 - w);
    const paceBlend =
      (team.pace_2526 ?? team.pace_2425 ?? LEAGUE_AVG_PACE) * w +
      (team.pace_2425 ?? team.pace_2526 ?? LEAGUE_AVG_PACE) * (1 - w);

    const played = gamesByTeam[team.team] ?? [];
    const ortgActual = ewma(ortgBlend, played.map((g) => g.ortg), alpha);
    const drtgActual = ewma(drtgBlend, played.map((g) => g.drtg), alpha);
    const paceActual = ewma(paceBlend, played.map((g) => g.pace), alpha);

    const net = transactionNetFor(team.team);
    // Transaktioiden delta on jo EPM-yksiköissä (pisteitä per 100 poss per
    // pelaajan minuuttiosuus) — lisätään ORTG/DRTG:hen samassa yksikössä,
    // painotettuna transactionNetFor:ssa lasketulla unohtamiskertoimella
    // (ks. yllä), jottei sama vaikutus näy sekä EWMA:ssa että deltana.
    const finalOrtg = ortgActual + net.o;
    const finalDrtg = drtgActual - net.d; // positiivinen D-EPM parantaa puolustusta -> DRTG:tä pienempi on parempi, joten vähennämme

    return {
      ortgBlend,
      drtgBlend,
      paceBlend,
      gamesPlayed: played.length,
      ortgActual,
      drtgActual,
      paceActual,
      netO: net.o,
      netD: net.d,
      finalOrtg,
      finalDrtg,
    };
  }

  const home = teams.find((t) => t.team === homeTeam);
  const away = teams.find((t) => t.team === awayTeam);
  const homeFinal = finalStatsFor(home);
  const awayFinal = finalStatsFor(away);

  const projection = useMemo(() => {
    if (!home || !away || !homeFinal || !awayFinal) return null;
    const pace = (homeFinal.paceActual + awayFinal.paceActual) / 2;
    const hca = home.home_adv ?? 0;
    // Pisteet/100 poss keskiarvo hyökkäys/puolustus-matchupista, skaalattu
    // pacella (poss/48min) ja jaettu 100:lla koska ORTG/DRTG on per 100 poss.
    const homePts = ((homeFinal.finalOrtg + awayFinal.finalDrtg) / 2) * (pace / 100) + hca / 2;
    const awayPts = ((awayFinal.finalOrtg + homeFinal.finalDrtg) / 2) * (pace / 100) - hca / 2;
    return {
      pace,
      hca,
      homePts,
      awayPts,
      spread: homePts - awayPts,
      total: homePts + awayPts,
    };
  }, [home, away, homeFinal, awayFinal]);

  if (loading) {
    return (
      <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
        Ladataan...
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Matchup-laskuri</h1>
      <a href="/dashboard" style={{ color: "#60a5fa", fontSize: 13, textDecoration: "underline" }}>
        ← Dashboard
      </a>
      <p style={{ color: "#64748b", fontSize: 13, margin: "8px 0 24px" }}>
        Yhdistää team_stats-taulun kausiblendauksen (23-24 vs 25-26, säädettävissä) ja
        Transaktiot-sivulla kirjatut treidien nettovaikutukset lopulliseksi ORTG/DRTG-arvoksi
        per joukkue, ja ennustaa sillä ottelun tuloksen.
      </p>

      {error && (
        <div style={{ color: "#f87171", marginBottom: 16, fontSize: 13 }}>
          Virhe: {error}
        </div>
      )}

      {teams.length === 0 && !error && (
        <div style={{ color: "#f87171", fontSize: 13, marginBottom: 16 }}>
          team_stats-taulu on tyhjä. Ajetaanko cron / siemendata ensin?
        </div>
      )}

      <div style={{ display: "flex", gap: 32, marginBottom: 24, flexWrap: "wrap" }}>
        <div>
          <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
            Kotijoukkue
          </label>
          <select
            value={homeTeam}
            onChange={(e) => setHomeTeam(e.target.value)}
            style={{ padding: 6, background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, minWidth: 220 }}
          >
            {teams.map((t) => (
              <option key={t.team} value={t.team}>
                {t.team}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
            Vierasjoukkue
          </label>
          <select
            value={awayTeam}
            onChange={(e) => setAwayTeam(e.target.value)}
            style={{ padding: 6, background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, minWidth: 220 }}
          >
            {teams.map((t) => (
              <option key={t.team} value={t.team}>
                {t.team}
              </option>
            ))}
          </select>
        </div>
        <div style={{ minWidth: 260 }}>
          <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
            Kausiblendaus — paino 25-26 kaudelle: {blendWeight}%
          </label>
          <input
            type="range"
            min={0}
            max={100}
            value={blendWeight}
            onChange={(e) => setBlendWeight(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <div style={{ fontSize: 11, color: "#64748b" }}>
            Joukkueet joilla &quot;Coach vaihtui&quot; ohittavat tämän ja käyttävät vain 25-26 kautta.
          </div>
        </div>
        <div style={{ minWidth: 260 }}>
          <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
            Pelattujen otteluiden paino (α): {alpha.toFixed(2)} (~{Math.round(1 / alpha)} pelin muisti)
          </label>
          <input
            type="range"
            min={0.05}
            max={0.5}
            step={0.01}
            value={alpha}
            onChange={(e) => setAlpha(Number(e.target.value))}
            style={{ width: "100%" }}
          />
          <div style={{ fontSize: 11, color: "#64748b" }}>
            Isompi α = viimeisin peli painaa enemmän, malli reagoi nopeammin. Pienempi α = vakaampi,
            vanhat pelit vaikuttavat kauemmin.
          </div>
        </div>
      </div>

      {projection && home && away && homeFinal && awayFinal && (
        <div
          style={{
            background: "#1e293b",
            borderRadius: 8,
            padding: 20,
            marginBottom: 32,
            display: "flex",
            gap: 40,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "#94a3b8" }}>{home.team}</div>
            <div style={{ fontSize: 36, fontWeight: 700 }}>{projection.homePts.toFixed(1)}</div>
            {home.coach_change && (
              <div style={{ fontSize: 10, color: "#fbbf24" }}>coach vaihtui — vain 25-26</div>
            )}
          </div>
          <div style={{ textAlign: "center", color: "#64748b", fontSize: 14 }}>
            —<br />
            <span style={{ fontSize: 11 }}>pace {projection.pace.toFixed(1)}</span>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 13, color: "#94a3b8" }}>{away.team}</div>
            <div style={{ fontSize: 36, fontWeight: 700 }}>{projection.awayPts.toFixed(1)}</div>
            {away.coach_change && (
              <div style={{ fontSize: 10, color: "#fbbf24" }}>coach vaihtui — vain 25-26</div>
            )}
          </div>
          <div style={{ marginLeft: "auto", textAlign: "right" }}>
            <div style={{ fontSize: 12, color: "#94a3b8" }}>Spread (koti)</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: projection.spread >= 0 ? "#4ade80" : "#f87171" }}>
              {projection.spread >= 0 ? "-" : "+"}
              {Math.abs(projection.spread).toFixed(1)}
            </div>
            <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 8 }}>Total</div>
            <div style={{ fontSize: 18 }}>{projection.total.toFixed(1)}</div>
          </div>
        </div>
      )}

      {homeFinal && awayFinal && home && away && (
        <table style={{ borderCollapse: "collapse", fontSize: 12, marginBottom: 32 }}>
          <thead>
            <tr style={{ color: "#94a3b8", textAlign: "left" }}>
              <th style={{ padding: 6 }}>Joukkue</th>
              <th style={{ padding: 6 }}>Preseason ORTG/DRTG</th>
              <th style={{ padding: 6 }}>Pelattu</th>
              <th style={{ padding: 6 }}>EWMA ORTG/DRTG</th>
              <th style={{ padding: 6 }}>Treidi netto O</th>
              <th style={{ padding: 6 }}>Treidi netto D</th>
              <th style={{ padding: 6 }}>Final ORTG</th>
              <th style={{ padding: 6 }}>Final DRTG</th>
              <th style={{ padding: 6 }}>Pace (EWMA)</th>
              <th style={{ padding: 6 }}>HCA</th>
            </tr>
          </thead>
          <tbody>
            <tr style={{ borderTop: "1px solid #334155" }}>
              <td style={{ padding: 6 }}>{home.team}</td>
              <td style={{ padding: 6, color: "#64748b" }}>
                {homeFinal.ortgBlend.toFixed(1)} / {homeFinal.drtgBlend.toFixed(1)}
              </td>
              <td style={{ padding: 6 }}>{homeFinal.gamesPlayed}</td>
              <td style={{ padding: 6 }}>
                {homeFinal.ortgActual.toFixed(1)} / {homeFinal.drtgActual.toFixed(1)}
              </td>
              <td style={{ padding: 6, color: homeFinal.netO >= 0 ? "#4ade80" : "#f87171" }}>
                {homeFinal.netO >= 0 ? "+" : ""}
                {homeFinal.netO.toFixed(2)}
              </td>
              <td style={{ padding: 6, color: homeFinal.netD <= 0 ? "#4ade80" : "#f87171" }}>
                {homeFinal.netD >= 0 ? "+" : ""}
                {homeFinal.netD.toFixed(2)}
              </td>
              <td style={{ padding: 6, fontWeight: 700 }}>{homeFinal.finalOrtg.toFixed(1)}</td>
              <td style={{ padding: 6, fontWeight: 700 }}>{homeFinal.finalDrtg.toFixed(1)}</td>
              <td style={{ padding: 6 }}>{homeFinal.paceActual.toFixed(1)}</td>
              <td style={{ padding: 6 }}>{home.home_adv ?? "—"}</td>
            </tr>
            <tr style={{ borderTop: "1px solid #334155" }}>
              <td style={{ padding: 6 }}>{away.team}</td>
              <td style={{ padding: 6, color: "#64748b" }}>
                {awayFinal.ortgBlend.toFixed(1)} / {awayFinal.drtgBlend.toFixed(1)}
              </td>
              <td style={{ padding: 6 }}>{awayFinal.gamesPlayed}</td>
              <td style={{ padding: 6 }}>
                {awayFinal.ortgActual.toFixed(1)} / {awayFinal.drtgActual.toFixed(1)}
              </td>
              <td style={{ padding: 6, color: awayFinal.netO >= 0 ? "#4ade80" : "#f87171" }}>
                {awayFinal.netO >= 0 ? "+" : ""}
                {awayFinal.netO.toFixed(2)}
              </td>
              <td style={{ padding: 6, color: awayFinal.netD <= 0 ? "#4ade80" : "#f87171" }}>
                {awayFinal.netD >= 0 ? "+" : ""}
                {awayFinal.netD.toFixed(2)}
              </td>
              <td style={{ padding: 6, fontWeight: 700 }}>{awayFinal.finalOrtg.toFixed(1)}</td>
              <td style={{ padding: 6, fontWeight: 700 }}>{awayFinal.finalDrtg.toFixed(1)}</td>
              <td style={{ padding: 6 }}>{awayFinal.paceActual.toFixed(1)}</td>
              <td style={{ padding: 6 }}>{away.home_adv ?? "—"}</td>
            </tr>
          </tbody>
        </table>
      )}

      <div style={{ fontSize: 11, color: "#475569", maxWidth: 700 }}>
        Kaava: EWMA ORTG/DRTG/Pace lasketaan käymällä läpi kaikki tähän mennessä pelatut
        ottelut kronologisessa järjestyksessä, alkaen preseason-blendatusta arvosta —
        jokainen peli päivittää ratingia kaavalla uusi = α × peli + (1−α) × vanha, joten
        vanhat pelit ja preseason-odotus unohtuvat eksponentiaalisesti sitä mukaa kun
        kautta pelataan. Treidien netto-EPM-vaikutus painotetaan samalla kaavalla käänteisesti:
        kerroin = (1−α)^(pelatut ottelut treidin jälkeen) — tuore treidi näkyy täysimääräisenä,
        mutta sitä mukaa kun joukkue pelaa otteluita uudella kokoonpanolla, käsin lisätty
        delta kutistuu samaa tahtia kuin todellinen pelidata alkaa jo itsessään heijastaa
        muutosta, jottei sama vaikutus lasketaan kahteen kertaan. Final ORTG = EWMA ORTG +
        painotettu treidinetto-O. Final DRTG = EWMA DRTG − painotettu treidinetto-D
        (positiivinen D-EPM parantaa puolustusta eli laskee DRTG:tä). Pisteet =
        ((oma Final ORTG + vastustajan Final DRTG) / 2) × (pace / 100), koti saa lisäksi
        +HCA/2 ja vieras −HCA/2.
      </div>
    </div>
  );
}
