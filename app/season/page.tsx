"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { computePreseason, loadPreSettingsRemote, DEFAULT_PRE_SETTINGS, type PreSettings, type PreTeam } from "@/lib/preseason";
import type { PrevRow } from "@/lib/prevSeason";
import { buildSchedule, teamInputs, simulateSeason, pOver, type SimResult, type TeamInput } from "@/lib/seasonSim";

const SEASON_START = "2026-10-01";

export default function SeasonPage() {
  const [teams, setTeams] = useState<(PreTeam & { home_adv: number | null })[]>([]);
  const [players, setPlayers] = useState<any[]>([]);
  const [prevRows, setPrevRows] = useState<PrevRow[]>([]);
  const [games, setGames] = useState<any[]>([]);
  const [settings, setSettings] = useState<PreSettings>(DEFAULT_PRE_SETTINGS);
  const [fatigue, setFatigue] = useState({ b2b: 2, threeInFour: 1.5 });
  const [loading, setLoading] = useState(true);
  const [sims, setSims] = useState(3000);
  const [baseSd, setBaseSd] = useState(2.5);
  const [turnoverSd, setTurnoverSd] = useState(2.0);
  const [injuryConc, setInjuryConc] = useState(3);
  const [gameSd, setGameSd] = useState(12);
  const [odds, setOdds] = useState(1.91);
  const [results, setResults] = useState<SimResult[] | null>(null);
  const [running, setRunning] = useState(false);
  const [openTeam, setOpenTeam] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [t, p, r, g, s] = await Promise.all([
          fetch("/api/team-stats").then((x) => x.json()),
          fetch("/api/players/import").then((x) => x.json()),
          fetch("/api/prev-season").then((x) => x.json()),
          fetch("/api/schedule").then((x) => x.json()),
          loadPreSettingsRemote(),
        ]);
        setTeams(t.teams ?? []);
        setPlayers((p.players ?? []).map((x: any) => ({ ...x, oepm: Number(x.oepm) || 0, depm: Number(x.depm) || 0, mpg_base: Number(x.mpg_base) || 0, active: x.active !== false })));
        setPrevRows((r.rows ?? []).map((x: any) => ({ ...x, gp: Number(x.gp) || 0, min_total: Number(x.min_total) || 0 })));
        setGames(g.games ?? []);
        setSettings(s);
        try {
          const m = (await fetch("/api/settings").then((x) => x.json()))?.settings?.model;
          if (m) setFatigue({ b2b: typeof m.b2bPenalty === "number" ? m.b2bPenalty : 2, threeInFour: typeof m.threeInFourPenalty === "number" ? m.threeInFourPenalty : 1.5 });
          if (m && typeof m.marginSd === "number") setGameSd(m.marginSd);
        } catch {
          // oletukset
        }
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const inputs: TeamInput[] = useMemo(() => {
    if (teams.length === 0 || players.length === 0) return [];
    const pre = computePreseason(teams, players, prevRows, settings);
    const base = teams
      .filter((t) => pre.byTeam[t.team])
      .map((t) => ({
        team: t.team,
        net: pre.byTeam[t.team].net,
        pace: pre.byTeam[t.team].paceBlend - (settings.paceShift ?? 0),
        hca: t.home_adv ?? 2.5,
      }));
    return teamInputs(base, players, prevRows, settings.carry.player / 100);
  }, [teams, players, prevRows, settings]);
  const schedule = useMemo(() => buildSchedule(games, SEASON_START, fatigue), [games, fatigue]);

  function run() {
    setRunning(true);
    setTimeout(() => {
      setResults(simulateSeason(inputs, schedule.games, { sims, baseSd, turnoverSd, injuryConc, gameSd }));
      setRunning(false);
    }, 20);
  }

  const winTotal = (team: string) => {
    const t = teams.find((x) => x.team === team);
    return t?.win_total != null ? Number(t.win_total) : null;
  };
  const inp = (team: string) => inputs.find((x) => x.team === team);
  const pctS = (p: number) => `${(p * 100).toFixed(p < 0.1 && p > 0 ? 1 : 0)} %`;
  const fair = (p: number) => (p <= 0.001 ? "—" : (1 / p).toFixed(2));
  const evS = (p: number) => {
    const ev = p * odds - 1;
    return <span style={{ color: ev > 0.03 ? "#4ade80" : ev > 0 ? "#a3e635" : "#64748b", fontWeight: ev > 0.03 ? 700 : 400 }}>{(ev * 100).toFixed(1)} %</span>;
  };
  const input = { background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "4px 6px", fontSize: 12, width: 64 };
  const th = { padding: "6px 8px", textAlign: "left" as const, color: "#94a3b8", fontWeight: 600, whiteSpace: "nowrap" as const };
  const td = { padding: "5px 8px", whiteSpace: "nowrap" as const, fontVariantNumeric: "tabular-nums" as const };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Kausi — voitot ja pudotuspelit</h1>
      <p style={{ color: "#64748b", fontSize: 13, margin: "8px 0 16px", maxWidth: 900, lineHeight: 1.6 }}>
        Monte Carlo -simulaatio koko runkosarjasta mallin kauden alun Netistä (sama kuin Teams-sivun preseason, asetukset
        Matchupista). Jokaisella simulointikierroksella joukkueen todellinen taso arvotaan epävarmuuden mukaan, tähtien poissaolot
        arvotaan erikseen, ja jokainen ottelu pelataan. Tulos: voittojen jakauma, todennäköisyys ylittää win total ja pudotuspelit
        (sijat 1–6 suoraan, 7–10 play-in).
      </p>

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 12, fontSize: 12, color: "#94a3b8" }}>
        <label>
          Simulaatioita
          <br />
          <input type="number" step={1000} value={sims} onChange={(e) => setSims(Math.max(200, Number(e.target.value) || 1000))} style={input} />
        </label>
        <label title="Kuinka paljon joukkueen todellinen taso voi poiketa kauden alun arviosta (Net-pisteinä, 1 hajonta). Mallin ero markkinaan oli ~1.4; markkinankin virhe koko kauden tuloksiin on ~2.5–3.">
          Tason epävarmuus (Net)
          <br />
          <input type="number" step={0.25} value={baseSd} onChange={(e) => setBaseSd(Number(e.target.value) || 0)} style={input} />
        </label>
        <label title="Lisäepävarmuus rosterimuutoksista: kerrotaan uusien pelaajien minuuttiosuudella (100 % uusi rosteri = tämä luku).">
          Rosterimuutoksen lisä (Net)
          <br />
          <input type="number" step={0.25} value={turnoverSd} onChange={(e) => setTurnoverSd(Number(e.target.value) || 0)} style={input} />
        </label>
        <label title="Loukkaantumisjakauman tiheys: pienempi = vaihtelevampi (osa kausista terve, osa paljon poissa).">
          Loukkaantumisten tiheys
          <br />
          <input type="number" step={0.5} value={injuryConc} onChange={(e) => setInjuryConc(Math.max(0.5, Number(e.target.value) || 3))} style={input} />
        </label>
        <label>
          Pelin hajonta (p)
          <br />
          <input type="number" step={0.5} value={gameSd} onChange={(e) => setGameSd(Number(e.target.value) || 12)} style={input} />
        </label>
        <label>
          Win total -kerroin
          <br />
          <input type="number" step={0.01} value={odds} onChange={(e) => setOdds(Number(e.target.value) || 1.91)} style={input} />
        </label>
        <button
          onClick={run}
          disabled={running || loading || inputs.length < 30}
          style={{ background: running || loading ? "#334155" : "#2563eb", color: "white", border: "none", borderRadius: 6, padding: "8px 16px", fontSize: 13, cursor: "pointer" }}
        >
          {running ? "Simuloidaan..." : loading ? "Ladataan..." : "Simuloi kausi"}
        </button>
      </div>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 16 }}>
        Otteluohjelma:{" "}
        {schedule.real
          ? `oikea (${schedule.games.length} ottelua, joista ${schedule.played} pelattu — tulokset kiinteinä). Väsymys ohjelmasta: B2B −${fatigue.b2b} p, 3 peliä / 4 pv −${fatigue.threeInFour} p (${schedule.b2bCount} B2B-tilannetta)`
          : "NBA:n rakenteen mukainen arvio ilman B2B:tä (divisioona 4, konferenssi ~3.6, toinen konferenssi 2 peliä) — hae oikea ohjelma Games-sivun napista, niin simulaatio käyttää sitä ja B2B-rasitusta"}
        {" · "}Asetukset: pelaajat {settings.carry.player} %, jäännös {settings.carry.res} %
        {settings.marketWeight > 0 ? `, win totalit ${settings.marketWeight} %` : ""}.
      </div>

      {results &&
        (["East", "West"] as const).map((conf) => (
          <div key={conf} style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 15, margin: "0 0 8px" }}>{conf === "East" ? "Itä" : "Länsi"}</h2>
            <div style={{ overflowX: "auto" }}>
              <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
                <thead>
                  <tr>
                    {["#", "Joukkue", "Net", "Loukk.", "Epävarm. ±", "Voitot", "10–90 %", "Win total", "P(over)", "Reilu O / U", `EV over / under @${odds}`, "Top 6", "Play-in", "Pudotuspelit", "1. sija"].map((h) => (
                      <th key={h} style={th}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {results
                    .filter((r) => r.conf === conf)
                    .sort((a, b) => b.meanWins - a.meanWins)
                    .map((r, i) => {
                      const wt = winTotal(r.team);
                      const po = wt != null ? pOver(r, wt) : null;
                      const ti = inp(r.team);
                      return (
                        <Fragment key={r.team}>
                          <tr style={{ borderTop: "1px solid #1f2937", cursor: "pointer" }} onClick={() => setOpenTeam(openTeam === r.team ? null : r.team)}>
                            <td style={{ ...td, color: "#475569" }}>{i + 1}</td>
                            <td style={{ ...td, color: "#e2e8f0" }}>{r.team}</td>
                            <td style={td}>{r.net >= 0 ? "+" : ""}{r.net.toFixed(1)}</td>
                            <td style={{ ...td, color: r.injuryMean > 1 ? "#fbbf24" : "#94a3b8" }}>−{r.injuryMean.toFixed(1)}</td>
                            <td style={{ ...td, color: r.p90 - r.p10 > 20 ? "#fbbf24" : "#94a3b8" }}>{((r.p90 - r.p10) / 2).toFixed(1)}</td>
                            <td style={{ ...td, fontWeight: 700 }}>{r.meanWins.toFixed(1)}</td>
                            <td style={{ ...td, color: "#94a3b8" }}>
                              {Math.round(r.p10)}–{Math.round(r.p90)}
                            </td>
                            <td style={td}>{wt ?? "—"}</td>
                            <td style={td}>{po != null ? pctS(po) : "—"}</td>
                            <td style={{ ...td, color: "#94a3b8" }}>{po != null ? `${fair(po)} / ${fair(1 - po)}` : "—"}</td>
                            <td style={td}>
                              {po != null ? (
                                <>
                                  {evS(po)} / {evS(1 - po)}
                                </>
                              ) : (
                                "—"
                              )}
                            </td>
                            <td style={td}>{pctS(r.pTop6)}</td>
                            <td style={td}>{pctS(r.pPlayIn)}</td>
                            <td style={{ ...td, fontWeight: 700 }}>
                              {pctS(r.pPlayoffs)} <span style={{ color: "#64748b", fontWeight: 400 }}>({fair(r.pPlayoffs)} / {fair(1 - r.pPlayoffs)})</span>
                            </td>
                            <td style={td}>{pctS(r.pSeed1)}</td>
                          </tr>
                          {openTeam === r.team && ti && (
                            <tr>
                              <td />
                              <td colSpan={14} style={{ padding: "4px 8px 10px", fontSize: 11, color: "#94a3b8", lineHeight: 1.7 }}>
                                Tason epävarmuus ±{r.sd.toFixed(2)} Net (uusia minuutteja {(ti.newShare * 100).toFixed(0)} %).{schedule.real ? ` B2B-pelejä ohjelmassa ${schedule.b2bByTeam[r.team] ?? 0}.` : ""} Tähtien poissaolot:{" "}
                                {ti.stars.length === 0
                                  ? "ei merkittäviä"
                                  : ti.stars.map((s) => `${s.name} (poissa ~${(s.missMean * 100).toFixed(0)} % peleistä, −${s.loss.toFixed(1)} Net kun poissa)`).join(" · ")}
                                . Voittojakauma: {r.winDist.map((x, w) => (x > 0.004 ? `${w}:${(x * 100).toFixed(0)}` : null)).filter(Boolean).join(" ")}
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                </tbody>
              </table>
            </div>
          </div>
        ))}

      {results && (
        <div style={{ fontSize: 11, color: "#64748b", maxWidth: 900, lineHeight: 1.7 }}>
          <strong>Loukk.</strong> = odotettu Net-menetys tähtien poissaoloista (kolme tärkeintä pelaajaa; odotettu poissaolo = puolet viime
          kauden poissaolo-osuudesta + puolet liigan keskiarvosta 12 %, enintään 35 %). <strong>Epävarm. ±</strong> = puolet 10–90 %
          -välin leveydestä voittoina — korkean varianssin joukkueet (tähtiriippuvaiset, paljon uusia pelaajia) keltaisella. Win totalin
          arvo syntyy usein juuri varianssista: korkean varianssin joukkueessa kumpikin puoli voi olla hinnoiteltu väärin, vaikka keskiarvo
          osuisi. Reilu kerroin = 1 / todennäköisyys (ilman marginaalia). Klikkaa riviä nähdäksesi erittelyn.
        </div>
      )}
    </div>
  );
}
