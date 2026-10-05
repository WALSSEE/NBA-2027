"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import { computePreseason, loadPreSettingsRemote, DEFAULT_PRE_SETTINGS, type PreSettings, type PreTeam } from "@/lib/preseason";
import type { PrevRow } from "@/lib/prevSeason";
import { withRatings } from "@/lib/ratings";
import { WINS_PER_NET } from "@/lib/preseason";
import { buildSchedule, teamInputs, simulateSeason, marketNets, pOver, autoSd, DIVISIONS, type SimResult, type TeamInput } from "@/lib/seasonSim";

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
  // Markkinan paino kausisimulaatiossa (win totalit). Kausivedoissa markkina on vahva: oletus 70 %.
  const [marketBlend, setMarketBlend] = useState(70);
  // Joukkuekohtainen varianssi (Net-hajonta), ohittaa automaattisen arvon. Tallennetaan tietokantaan.
  const [sdOv, setSdOv] = useState<Record<string, number>>({});
  const [ovLoaded, setOvLoaded] = useState(false);
  const [secret, setSecret] = useState("");
  const [used, setUsed] = useState<Record<string, { model: number; market: number | null; used: number }>>({});

  useEffect(() => {
    (async () => {
      try {
        const [t, p, r, g, s] = await Promise.all([
          fetch("/api/team-stats").then((x) => x.json()),
          fetch("/api/players/import").then((x) => x.json()),
          fetch("/api/prev-season").then((x) => x.json()),
          fetch("/api/schedule", { cache: "no-store" }).then((x) => x.json()),
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
          const so = (await fetch("/api/settings").then((x) => x.json()))?.settings?.season;
          if (so) {
            if (so.sdOv) setSdOv(so.sdOv);
            if (typeof so.marketBlend === "number") setMarketBlend(so.marketBlend);
          }
        } catch {
          // oletukset
        }
      } finally {
        setLoading(false);
        setOvLoaded(true);
        setSecret(localStorage.getItem("cron_secret") ?? "");
      }
    })();
  }, []);
  // Säätöjen tallennus tietokantaan
  const ovJson = JSON.stringify({ sdOv, marketBlend });
  useEffect(() => {
    if (!ovLoaded || !secret) return;
    const t = setTimeout(() => {
      fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ key: "season", value: JSON.parse(ovJson) }),
      }).catch(() => {});
    }, 1000);
    return () => clearTimeout(t);
  }, [ovJson, ovLoaded, secret]);

  const inputs: TeamInput[] = useMemo(() => {
    if (teams.length === 0 || players.length === 0) return [];
    // Win totalit sekoitetaan tällä sivulla omalla painollaan, joten Matchupin win total -painoa ei käytetä tässä.
    const rp = withRatings(players, settings.ratingSource ?? "avg");
    const pre = computePreseason(teams, rp, prevRows, { ...settings, marketWeight: 0 }, undefined, games as any);
    const base = teams
      .filter((t) => pre.byTeam[t.team])
      .map((t) => ({
        team: t.team,
        // tunnetut pitkät poissaolot vähennetty; odotetut satunnaiset poissaolot arvotaan simulaatiossa
        net: pre.byTeam[t.team].seasonNet + pre.byTeam[t.team].injO + pre.byTeam[t.team].injD,
        pace: pre.byTeam[t.team].paceBlend - (settings.paceShift ?? 0),
        hca: t.home_adv ?? 2.5,
      }));
    const mean = base.reduce((a, t) => a + t.net, 0) / Math.max(1, base.length);
    const known: Record<string, number> = {};
    for (const r of Object.values(pre.byTeam)) for (const x of r.avail?.list ?? []) known[x.name] = x.share;
    const ti = teamInputs(base.map((t) => ({ ...t, net: t.net - mean })), rp, prevRows, settings.carry.player / 100, undefined, known, settings.injuryAdj !== false);
    return ti.map((t) => ({ ...t, sdOverride: sdOv[t.team] }));
  }, [teams, players, prevRows, settings, sdOv, games]);
  const schedule = useMemo(() => buildSchedule(games, SEASON_START, fatigue), [games, fatigue]);

  function run() {
    setRunning(true);
    setTimeout(() => {
      const opt = { sims, baseSd, turnoverSd, injuryConc, gameSd };
      const lines: Record<string, number> = {};
      for (const t of teams) if (t.win_total != null) lines[t.team] = Number(t.win_total);
      const w = marketBlend / 100;
      // Blendaus tehdään voittojen asteikolla: tavoite = w × win total + (1 − w) × mallin voitot
      // (41 + 2.7 × Net). Sitten haetaan simulaatiolla Netit, joilla simuloitu keskiarvo osuu
      // tavoitteeseen — sama inflaatio (varianssi, loukkaantumiset) koskee sekä markkinaa että mallia.
      // (Aiemmin markkinan kalibroitu Net ja mallin raaka Net blendattiin suoraan, mikä puristi kärki- ja
      // häntäjoukkueita kohti keskikastia.)
      // Mallin odotettu taso voittoina. Kun odotetut poissaolot ovat pois päältä, mallin Net on kalibroitu
      // suoraan markkinan win totaleihin (poissaolot sisältyvät kalibrointiin), joten niitä EI vähennetä
      // uudelleen — muuten hyvät joukkueet painuvat alle ja huonot yli. Päällä: Net on terve taso ja
      // odotetut poissaolot vähennetään (sama, jonka simulaatio arpoo).
      const injOn = settings.injuryAdj !== false;
      const expNet = (t: TeamInput) => t.net - (injOn ? t.stars.reduce((a, st) => a + st.loss * st.missMean, 0) : 0);
      const modelMean = inputs.reduce((a, t) => a + expNet(t), 0) / Math.max(1, inputs.length);
      const targets: Record<string, number> = {};
      for (const t of inputs) {
        const modelWins = 41 + WINS_PER_NET * (expNet(t) - modelMean);
        targets[t.team] = lines[t.team] != null ? w * lines[t.team] + (1 - w) * modelWins : modelWins;
      }
      const mk = w > 0 && Object.keys(lines).length >= 20 ? marketNets(inputs, schedule.games, targets, opt) : {};
      const u: Record<string, { model: number; market: number | null; used: number }> = {};
      const blended = inputs.map((t) => {
        const net = mk[t.team] != null ? mk[t.team] : t.net;
        u[t.team] = { model: expNet(t) - modelMean, market: lines[t.team] != null ? (lines[t.team] - 41) / WINS_PER_NET : null, used: net };
        return { ...t, net };
      });
      setUsed(u);
      setResults(simulateSeason(blended, schedule.games, opt));
      setRunning(false);
    }, 20);
  }

  // Vedonlyöntilinja ja kertoimet (Teams-sivu); ilman linjaa käytetään odotettuja voittoja ja yleistä kerrointa.
  const winTotal = (team: string) => {
    const t = teams.find((x) => x.team === team) as any;
    if (t?.wt_line != null) return Number(t.wt_line);
    return t?.win_total != null ? Number(t.win_total) : null;
  };
  const oddsOf = (team: string) => {
    const t = teams.find((x) => x.team === team) as any;
    return { over: t?.wt_over != null ? Number(t.wt_over) : odds, under: t?.wt_under != null ? Number(t.wt_under) : odds, own: t?.wt_over != null };
  };
  const inp = (team: string) => inputs.find((x) => x.team === team);
  const signedN = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(1)}`;
  const pctS = (p: number) => `${(p * 100).toFixed(p < 0.1 && p > 0 ? 1 : 0)} %`;
  const fair = (p: number) => (p <= 0.001 ? "—" : (1 / p).toFixed(2));
  const evS = (p: number, o: number = odds) => {
    const ev = p * o - 1;
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
        <label title="Kuinka paljon kausisimulaation joukkuetaso nojaa markkinan win totaleihin (0 % = pelkkä malli). Win totalit ovat tehokkaita markkinoita, joten kausivedoissa suositus on 60–80 %.">
          Win totalien paino (%)
          <br />
          <input type="number" step={10} min={0} max={100} value={marketBlend} onChange={(e) => setMarketBlend(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} style={input} />
        </label>
        <label>
          Oletuskerroin (ilman omaa)
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
          ? `oikea (${schedule.realCount} ottelua${schedule.filled ? ` + ${schedule.filled} NBA Cupin jälkeen päätettävää peliä täydennetty painotettuina` : ""}, joista ${schedule.played} pelattu — tulokset kiinteinä). Väsymys ohjelmasta: B2B −${fatigue.b2b} p, 3 peliä / 4 pv −${fatigue.threeInFour} p (${schedule.b2bCount} B2B-tilannetta)`
          : "NBA:n rakenteen mukainen arvio ilman B2B:tä (divisioona 4, konferenssi ~3.6, toinen konferenssi 2 peliä) — hae oikea ohjelma Games-sivun napista, niin simulaatio käyttää sitä ja B2B-rasitusta"}
        {schedule.real && (schedule.realCount > 1235 || schedule.realCount < 1195) && (
          <span style={{ color: "#f87171" }}>
            {" "}
            — HUOM: runkosarjassa pitäisi olla 1230 ottelua. {schedule.realCount > 1230 ? "Ohjelmassa on tuplia — hae ohjelma uudelleen Games-sivulta." : "Ohjelmasta puuttuu otteluita — hae ohjelma uudelleen Games-sivulta."}
          </span>
        )}
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
                    {["#", "Joukkue", "Net", "Loukk.", "Varianssi (Net)", "Epävarm. ±", "Voitot", "10–90 %", "Linja (yli / alle)", "P(over)", "Reilu O / U", "EV over / under", "Top 6", "Play-in", "Pudotuspelit", "Divisioona", "1. sija", "Konf.", "Mestari"].map((h) => (
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
                            <td style={td} onClick={(e) => e.stopPropagation()}>
                              <input
                                type="number"
                                step={0.5}
                                min={1}
                                max={6}
                                value={sdOv[r.team] ?? Number((ti ? autoSd(ti, { baseSd, turnoverSd }) : r.sd).toFixed(1))}
                                onChange={(e) => {
                                  const raw = e.target.value;
                                  setSdOv((x) => {
                                    const n = { ...x };
                                    if (raw === "") delete n[r.team];
                                    else n[r.team] = Math.max(0, Math.min(8, Number(raw) || 0));
                                    return n;
                                  });
                                }}
                                title="Joukkueen tason epävarmuus Net-pisteinä (1 hajonta). Tyhjä/automaattinen = perustaso + rosterimuutokset."
                                style={{ ...input, width: 52, borderColor: sdOv[r.team] != null ? "#fbbf24" : "#334155" }}
                              />
                              {sdOv[r.team] != null && (
                                <button
                                  onClick={() =>
                                    setSdOv((x) => {
                                      const n = { ...x };
                                      delete n[r.team];
                                      return n;
                                    })
                                  }
                                  title="Palauta automaattinen"
                                  style={{ background: "transparent", color: "#64748b", border: "none", cursor: "pointer", fontSize: 12 }}
                                >
                                  ↺
                                </button>
                              )}
                            </td>
                            <td style={{ ...td, color: r.p90 - r.p10 > 20 ? "#fbbf24" : "#94a3b8" }}>{((r.p90 - r.p10) / 2).toFixed(1)}</td>
                            <td style={{ ...td, fontWeight: 700 }}>{r.meanWins.toFixed(1)}</td>
                            <td style={{ ...td, color: "#94a3b8" }}>
                              {Math.round(r.p10)}–{Math.round(r.p90)}
                            </td>
                            <td style={td}>
                              {wt ?? "—"}
                              {oddsOf(r.team).own && (
                                <span style={{ color: "#64748b", fontSize: 11 }}>
                                  {" "}
                                  ({oddsOf(r.team).over.toFixed(2)} / {oddsOf(r.team).under.toFixed(2)})
                                </span>
                              )}
                            </td>
                            <td style={td}>{po != null ? pctS(po) : "—"}</td>
                            <td style={{ ...td, color: "#94a3b8" }}>{po != null ? `${fair(po)} / ${fair(1 - po)}` : "—"}</td>
                            <td style={td}>
                              {po != null ? (
                                <>
                                  {evS(po, oddsOf(r.team).over)} / {evS(1 - po, oddsOf(r.team).under)}
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
                            <td style={td}>
                              <strong>{pctS(r.pDiv)}</strong> <span style={{ color: "#64748b" }}>({fair(r.pDiv)})</span>
                            </td>
                            <td style={td}>{pctS(r.pSeed1)}</td>
                            <td style={td}>{pctS(r.pConf)}</td>
                            <td style={td}>
                              <strong>{pctS(r.pChamp)}</strong>
                            </td>
                          </tr>
                          {openTeam === r.team && ti && (
                            <tr>
                              <td />
                              <td colSpan={18} style={{ padding: "4px 8px 10px", fontSize: 11, color: "#94a3b8", lineHeight: 1.9 }}>
                                <div>
                                  Net: malli {used[r.team] ? signedN(used[r.team].model) : "—"}
                                  {used[r.team]?.market != null ? ` · markkina ${signedN(used[r.team].market!)}` : ""} · käytetty {signedN(r.net)}. Tason epävarmuus ±
                                  {r.sd.toFixed(2)} Net (uusia minuutteja {(ti.newShare * 100).toFixed(0)} %).
                                  {schedule.real ? ` B2B-pelejä ohjelmassa ${schedule.b2bByTeam[r.team] ?? 0}.` : ""}
                                </div>
                                <div>
                                  Odotetut poissaolot (oma ennuste tai oletus, simulaatiossa arvottu; 5 merkittävintä):{" "}
                                  {ti.stars.length === 0
                                    ? "ei merkittäviä"
                                    : [...ti.stars].sort((x, y) => y.loss * y.missMean - x.loss * x.missMean).slice(0, 5).map((st) => `${st.name} ~${Math.round(st.missMean * 100)} % peleistä (−${st.loss.toFixed(1)} Net kun poissa)`).join(" · ")}
                                </div>
                                <div>
                                  Voittojakauma: {r.winDist.map((x, w) => (x > 0.004 ? `${w}:${(x * 100).toFixed(0)}` : null)).filter(Boolean).join(" ")}
                                </div>
                                <AltLines r={r} line={wt} />
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

      {results && <H2HTable results={results} />}

      {results && <ChampTable results={results} />}

      {results && <DivisionTable results={results} />}

      {results && (
        <div style={{ fontSize: 11, color: "#64748b", maxWidth: 900, lineHeight: 1.7 }}>
          <strong>Varianssi (Net)</strong> = joukkueen tason epävarmuus (1 hajonta Net-pisteinä); muokattava, keltainen reuna = käsin
          asetettu, ↺ palauttaa automaattisen. Ohje: 1.5–2 vakaa (sama runko ja valmentaja), 2.5 normaali, 3–3.5 epävarma (uusi valmentaja,
          paljon uusia pelaajia, nuori joukkue), 4–5 hyvin epävarma (tankkausmahdollisuus, tähden terveys tai kauppa auki). Yksi Net-piste
          ≈ 2.7 voittoa. Aja simulaatio uudelleen muutosten jälkeen. <strong>Loukk.</strong> = odotettu Net-menetys tähtien poissaoloista (kolme tärkeintä pelaajaa; odotettu poissaolo = puolet viime
          kauden poissaolo-osuudesta + puolet liigan keskiarvosta 12 %, enintään 35 %). <strong>Epävarm. ±</strong> = puolet 10–90 %
          -välin leveydestä voittoina — korkean varianssin joukkueet (tähtiriippuvaiset, paljon uusia pelaajia) keltaisella. Win totalin
          arvo syntyy usein juuri varianssista: korkean varianssin joukkueessa kumpikin puoli voi olla hinnoiteltu väärin, vaikka keskiarvo
          osuisi. Reilu kerroin = 1 / todennäköisyys (ilman marginaalia). Klikkaa riviä nähdäksesi erittelyn.
        </div>
      )}
    </div>
  );
}

// Vaihtoehtoiset O/U-linjat: simulaation P(yli) ja reilut kertoimet usealle linjalle sekä oma linja kertoimineen -> EV.
function AltLines({ r, line }: { r: SimResult; line: number | null }) {
  const [cl, setCl] = useState<string>("");
  const [co, setCo] = useState<string>("");
  const [cu, setCu] = useState<string>("");
  const center = Math.floor(line ?? r.meanWins);
  const lines: number[] = [];
  for (let k = -6; k <= 6; k++) lines.push(center + 0.5 + k);
  const fair = (p: number) => (p <= 0.001 ? "—" : (1 / p).toFixed(2));
  const cell = { padding: "1px 8px", textAlign: "right" as const, fontVariantNumeric: "tabular-nums" as const };
  const L = parseFloat(cl.replace(",", "."));
  const O = parseFloat(co.replace(",", "."));
  const U = parseFloat(cu.replace(",", "."));
  const pO = Number.isFinite(L) ? pOver(r, L) : null;
  // tasaluku: push palauttaa panoksen -> EV lasketaan ilman push-todennäköisyyttä
  const pPush = Number.isFinite(L) && Number.isInteger(L) ? r.winDist[L] ?? 0 : 0;
  const ev = (p: number, o: number) => p * o + pPush - 1;
  const evStyle = (v: number) => ({ color: v > 0.03 ? "#4ade80" : v > 0 ? "#a3e635" : "#64748b", fontWeight: v > 0.03 ? 700 : 400 });
  const inp = { background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: "2px 6px", fontSize: 11, width: 60 };
  return (
    <div style={{ marginTop: 6 }} onClick={(e) => e.stopPropagation()}>
      <div style={{ color: "#cbd5e1" }}>Vaihtoehtoiset linjat (simulaatio):</div>
      <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
        <thead>
          <tr style={{ color: "#64748b" }}>
            <th style={cell}>Linja</th>
            <th style={cell}>P(yli)</th>
            <th style={cell}>Reilu yli</th>
            <th style={cell}>Reilu alle</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => {
            const p = pOver(r, l);
            return (
              <tr key={l} style={{ color: l === line ? "#e2e8f0" : "#94a3b8", fontWeight: l === line ? 700 : 400 }}>
                <td style={cell}>{l.toFixed(1)}</td>
                <td style={cell}>{(p * 100).toFixed(0)} %</td>
                <td style={cell}>{fair(p)}</td>
                <td style={cell}>{fair(1 - p)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 6, alignItems: "center", marginTop: 6, flexWrap: "wrap" }}>
        <span>Oma linja:</span>
        <input value={cl} onChange={(e) => setCl(e.target.value)} placeholder="esim. 38.5" style={inp} />
        <span>yli</span>
        <input value={co} onChange={(e) => setCo(e.target.value)} placeholder="kerroin" style={inp} />
        <span>alle</span>
        <input value={cu} onChange={(e) => setCu(e.target.value)} placeholder="kerroin" style={inp} />
        {pO != null && (
          <span>
            P(yli) {(pO * 100).toFixed(1)} %{pPush > 0 ? ` · push ${(pPush * 100).toFixed(1)} %` : ""} · reilu {fair(pO)} / {fair(1 - pO - pPush)}
            {Number.isFinite(O) && (
              <>
                {" "}· EV yli <span style={evStyle(ev(pO, O))}>{(ev(pO, O) * 100).toFixed(1)} %</span>
              </>
            )}
            {Number.isFinite(U) && (
              <>
                {" "}· EV alle <span style={evStyle(ev(1 - pO - pPush, U))}>{(ev(1 - pO - pPush, U) * 100).toFixed(1)} %</span>
              </>
            )}
          </span>
        )}
      </div>
    </div>
  );
}

// Divisioonien voittajat: simulaation todennäköisyys, reilu kerroin ja oma tarjottu kerroin -> EV.
function DivisionTable({ results }: { results: SimResult[] }) {
  const [odds, setOdds] = useState<Record<string, string>>({});
  const by = new Map(results.map((r) => [r.team, r]));
  const fair = (p: number) => (p <= 0.0005 ? "—" : (1 / p).toFixed(2));
  const cell = { padding: "2px 8px", fontVariantNumeric: "tabular-nums" as const };
  const inp = { background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: "1px 6px", fontSize: 11, width: 56 };
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Divisioonien voittajat</h2>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
        Todennäköisyys = osuus simulaatioista, joissa joukkue voitti divisioonansa (eniten voittoja; tasatilanteet arvottu, ei NBA:n
        tiebreak-sääntöjä). Syötä tarjottu kerroin, niin EV lasketaan.
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(330px, 1fr))", gap: 14 }}>
        {Object.entries(DIVISIONS).map(([div, d]) => (
          <div key={div} style={{ border: "1px solid #1f2937", borderRadius: 8, padding: 8 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>
              {div} <span style={{ color: "#64748b", fontWeight: 400 }}>({d.conf === "East" ? "Itä" : "Länsi"})</span>
            </div>
            <table style={{ borderCollapse: "collapse", fontSize: 11, width: "100%" }}>
              <thead>
                <tr style={{ color: "#64748b", textAlign: "left" }}>
                  <th style={cell}>Joukkue</th>
                  <th style={cell}>Voitot</th>
                  <th style={cell}>P</th>
                  <th style={cell}>Reilu</th>
                  <th style={cell}>Kerroin</th>
                  <th style={cell}>EV</th>
                </tr>
              </thead>
              <tbody>
                {d.teams
                  .map((t) => by.get(t))
                  .filter((r): r is SimResult => !!r)
                  .sort((a, b) => b.pDiv - a.pDiv)
                  .map((r) => {
                    const o = parseFloat((odds[r.team] ?? "").replace(",", "."));
                    const ev = Number.isFinite(o) ? r.pDiv * o - 1 : null;
                    return (
                      <tr key={r.team} style={{ borderTop: "1px solid #1f2937", color: "#cbd5e1" }}>
                        <td style={cell}>{r.team}</td>
                        <td style={cell}>{r.meanWins.toFixed(1)}</td>
                        <td style={{ ...cell, fontWeight: 700 }}>{(r.pDiv * 100).toFixed(r.pDiv < 0.1 ? 1 : 0)} %</td>
                        <td style={{ ...cell, color: "#94a3b8" }}>{fair(r.pDiv)}</td>
                        <td style={cell}>
                          <input value={odds[r.team] ?? ""} onChange={(e) => setOdds((x) => ({ ...x, [r.team]: e.target.value }))} placeholder="—" style={inp} />
                        </td>
                        <td style={{ ...cell, color: ev == null ? "#475569" : ev > 0.03 ? "#4ade80" : ev > 0 ? "#a3e635" : "#64748b", fontWeight: ev != null && ev > 0.03 ? 700 : 400 }}>
                          {ev == null ? "" : `${(ev * 100).toFixed(1)} %`}
                        </td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}

// Mestaruus ja putoamisvaihe: jokaisen joukkueen kauden päätepisteen jakauma (summa 100 %).
function ChampTable({ results }: { results: SimResult[] }) {
  const [odds, setOdds] = useState<Record<string, string>>({});
  const [confOdds, setConfOdds] = useState<Record<string, string>>({});
  const fair = (p: number) => (p <= 0.0005 ? "—" : (1 / p).toFixed(p < 0.02 ? 0 : 2));
  const pc = (p: number) => (p < 0.0005 ? "–" : `${(p * 100).toFixed(p < 0.1 ? 1 : 0)} %`);
  const cell = { padding: "2px 8px", fontVariantNumeric: "tabular-nums" as const, textAlign: "right" as const };
  const inp = { background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: "1px 6px", fontSize: 11, width: 54 };
  const evCell = (p: number, raw: string | undefined) => {
    const o = parseFloat((raw ?? "").replace(",", "."));
    if (!Number.isFinite(o)) return <td style={cell} />;
    const ev = p * o - 1;
    return <td style={{ ...cell, color: ev > 0.03 ? "#4ade80" : ev > 0 ? "#a3e635" : "#64748b", fontWeight: ev > 0.03 ? 700 : 400 }}>{(ev * 100).toFixed(1)} %</td>;
  };
  const heads = ["Ei play-iniin", "Putosi play-in", "Putosi 1. kierr.", "Putosi 2. kierr.", "Putosi konf.fin.", "Hävisi finaalin", "Mestari"];
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>Mestaruus ja putoamisvaihe</h2>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, maxWidth: 900, lineHeight: 1.6 }}>
        Jokaisessa simulaatiossa pelataan play-in (7–8 ja 9–10, häviäjä 7–8 vs. voittaja 9–10) ja pudotuspelit paras seitsemästä
        (1–8, 4–5, 3–6, 2–7; parempi sija saa kotiedun 2-2-1-1-1, finaalissa parempi voittomäärä). Joukkueen taso ja tähtien poissaolot
        ovat samat kuin runkosarjassa kyseisessä simulaatiossa. Rivi summautuu 100 %:iin. Syötä tarjottu kerroin, niin EV lasketaan.
        Huom: pudotuspeleissä tähdet pelaavat enemmän minuutteja, mitä malli ei huomioi — kärkijoukkueiden mestaruustodennäköisyys voi olla
        hieman aliarvioitu.
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", fontSize: 11 }}>
          <thead>
            <tr style={{ color: "#64748b" }}>
              <th style={{ ...cell, textAlign: "left" }}>Joukkue</th>
              {heads.map((h) => (
                <th key={h} style={cell}>
                  {h}
                </th>
              ))}
              <th style={cell}>Reilu mestari</th>
              <th style={cell}>Kerroin</th>
              <th style={cell}>EV</th>
              <th style={cell}>Konf. mestari</th>
              <th style={cell}>Reilu</th>
              <th style={cell}>Kerroin</th>
              <th style={cell}>EV</th>
            </tr>
          </thead>
          <tbody>
            {[...results]
              .sort((a, b) => b.pChamp - a.pChamp || b.pConf - a.pConf || b.meanWins - a.meanWins)
              .map((r) => (
                <tr key={r.team} style={{ borderTop: "1px solid #1f2937", color: "#cbd5e1" }}>
                  <td style={{ ...cell, textAlign: "left", whiteSpace: "nowrap" }}>{r.team}</td>
                  {r.stage.map((p, k) => (
                    <td key={k} style={{ ...cell, color: k === 6 ? "#e2e8f0" : "#94a3b8", fontWeight: k === 6 ? 700 : 400 }}>
                      {pc(p)}
                    </td>
                  ))}
                  <td style={{ ...cell, color: "#94a3b8" }}>{fair(r.pChamp)}</td>
                  <td style={cell}>
                    <input value={odds[r.team] ?? ""} onChange={(e) => setOdds((x) => ({ ...x, [r.team]: e.target.value }))} placeholder="—" style={inp} />
                  </td>
                  {evCell(r.pChamp, odds[r.team])}
                  <td style={cell}>{pc(r.pConf)}</td>
                  <td style={{ ...cell, color: "#94a3b8" }}>{fair(r.pConf)}</td>
                  <td style={cell}>
                    <input value={confOdds[r.team] ?? ""} onChange={(e) => setConfOdds((x) => ({ ...x, [r.team]: e.target.value }))} placeholder="—" style={inp} />
                  </td>
                  {evCell(r.pConf, confOdds[r.team])}
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// H2H kausivoitot: kaksi joukkuetta samoista simulaatioista (yhteiset ottelut ja vaihtelu mukana).
// Voitot pyöristetään kokonaisluvuiksi; sama määrä = push (panos palautetaan).
function H2HTable({ results }: { results: SimResult[] }) {
  const teams = [...results].map((r) => r.team).sort();
  const [a, setA] = useState(teams[0] ?? "");
  const [b, setB] = useState(teams[1] ?? "");
  const [oa, setOa] = useState("");
  const [ob, setOb] = useState("");
  const [hc, setHc] = useState("0"); // tasoitus joukkueelle A (esim. -2.5)
  const ra = results.find((r) => r.team === a);
  const rb = results.find((r) => r.team === b);
  const inp = { background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 4, padding: "3px 6px", fontSize: 12 };
  let pa = 0, pb = 0, pp = 0, diffSum = 0;
  const h = parseFloat(hc.replace(",", ".")) || 0;
  if (ra && rb && a !== b) {
    const n = ra.simWins.length;
    for (let i = 0; i < n; i++) {
      const d = Math.round(ra.simWins[i]) + h - Math.round(rb.simWins[i]);
      diffSum += Math.round(ra.simWins[i]) - Math.round(rb.simWins[i]);
      if (Math.abs(d) < 1e-9) pp++;
      else if (d > 0) pa++;
      else pb++;
    }
    pa /= n; pb /= n; pp /= n; diffSum /= n;
  }
  const fair2 = (p: number) => (p <= 0.0005 ? "—" : ((1 - pp) / p).toFixed(2)); // push palautetaan
  const fair3 = (p: number) => (p <= 0.0005 ? "—" : (1 / p).toFixed(2));
  const ev = (p: number, raw: string) => {
    const o = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(o)) return null;
    return p * o + pp - 1; // push palauttaa panoksen
  };
  const evSpan = (v: number | null) =>
    v == null ? null : (
      <span style={{ color: v > 0.03 ? "#4ade80" : v > 0 ? "#a3e635" : "#64748b", fontWeight: v > 0.03 ? 700 : 400 }}>EV {(v * 100).toFixed(1)} %</span>
    );
  return (
    <div style={{ marginBottom: 28 }}>
      <h2 style={{ fontSize: 15, margin: "0 0 4px" }}>H2H kausivoitot</h2>
      <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8, maxWidth: 900, lineHeight: 1.6 }}>
        Kumpi joukkue voittaa runkosarjassa enemmän otteluita. Lasketaan samoista simulaatioista, joten keskinäiset ottelut ja
        yhteinen vaihtelu ovat mukana. Tasamäärä = push (panos palautetaan). Tasoitus lisätään joukkueen A voittoihin (esim. −1.5).
      </div>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 10, fontSize: 12 }}>
        <select value={a} onChange={(e) => setA(e.target.value)} style={inp}>
          {teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span style={{ color: "#64748b" }}>vs</span>
        <select value={b} onChange={(e) => setB(e.target.value)} style={inp}>
          {teams.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <span style={{ color: "#94a3b8", marginLeft: 8 }}>Tasoitus A</span>
        <input value={hc} onChange={(e) => setHc(e.target.value)} style={{ ...inp, width: 56 }} />
      </div>
      {ra && rb && a !== b ? (
        <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr style={{ color: "#64748b", textAlign: "left" }}>
              {["", "Odot. voitot", "P (voittaa)", "Reilu (push palautus)", "Reilu 3-tie", "Kerroin", ""].map((x, i) => (
                <th key={i} style={{ padding: "3px 10px" }}>{x}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[
              { name: a, r: ra, p: pa, odds: oa, set: setOa },
              { name: b, r: rb, p: pb, odds: ob, set: setOb },
            ].map((x) => (
              <tr key={x.name} style={{ borderTop: "1px solid #1f2937", color: "#cbd5e1" }}>
                <td style={{ padding: "3px 10px" }}>{x.name}</td>
                <td style={{ padding: "3px 10px" }}>{x.r.meanWins.toFixed(1)}</td>
                <td style={{ padding: "3px 10px", fontWeight: 700 }}>{(x.p * 100).toFixed(1)} %</td>
                <td style={{ padding: "3px 10px" }}>{fair2(x.p)}</td>
                <td style={{ padding: "3px 10px", color: "#94a3b8" }}>{fair3(x.p)}</td>
                <td style={{ padding: "3px 10px" }}>
                  <input value={x.odds} onChange={(e) => x.set(e.target.value)} placeholder="—" style={{ ...inp, width: 60 }} />
                </td>
                <td style={{ padding: "3px 10px" }}>{evSpan(ev(x.p, x.odds))}</td>
              </tr>
            ))}
            <tr style={{ borderTop: "1px solid #1f2937", color: "#94a3b8" }}>
              <td style={{ padding: "3px 10px" }}>Tasan (push)</td>
              <td style={{ padding: "3px 10px" }}>ero {diffSum >= 0 ? "+" : ""}{diffSum.toFixed(1)}</td>
              <td style={{ padding: "3px 10px" }}>{(pp * 100).toFixed(1)} %</td>
              <td />
              <td style={{ padding: "3px 10px" }}>{fair3(pp)}</td>
              <td />
              <td />
            </tr>
          </tbody>
        </table>
      ) : (
        <div style={{ fontSize: 12, color: "#64748b" }}>Valitse kaksi eri joukkuetta.</div>
      )}
    </div>
  );
}

