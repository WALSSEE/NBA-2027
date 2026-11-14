"use client";

import { useEffect, useMemo, useState } from "react";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";
import { computePreseason, loadPreSettings, loadPreSettingsRemote, DEFAULT_PRE_SETTINGS, type PreSettings } from "@/lib/preseason";
import type { PrevRow } from "@/lib/prevSeason";
import { withRatings } from "@/lib/ratings";
import SourceCompare from "./SourceCompare";
import { teamModelFor, gamesByTeamFrom, seasonStartFrom, type TxRow } from "@/lib/teamModel";

type TeamStats = {
  id?: string;
  team: string;
  pace_2425: number | null;
  ortg_2425: number | null;
  drtg_2425: number | null;
  pace_2526: number | null;
  ortg_2526: number | null;
  drtg_2526: number | null;
  coach_change: boolean | null;
  home_adv: number | null;
  win_total: number | null;
  wt_line?: number | null; // vedonlyöntilinja (esim. 43.5)
  wt_over?: number | null; // kerroin yli
  wt_under?: number | null; // kerroin alle
  adj_ortg?: number | null; // käsin säätö mallin lukuihin (Matchup käyttää)
  adj_drtg?: number | null;
  adj_pace?: number | null;
};

type NumField = "ortg_2425" | "drtg_2425" | "pace_2425" | "ortg_2526" | "drtg_2526" | "pace_2526" | "home_adv" | "win_total" | "wt_line" | "wt_over" | "wt_under";
type ModelKey = "m_net" | "m_ortg" | "m_drtg" | "m_pace";
type CurKey = "cur_gp" | "cur_wpct" | "cur_net" | "cur_ortg" | "cur_drtg" | "cur_pace" | "cur_l10" | "cur_vs_pre";
type SortKey = ModelKey | CurKey | "team" | "net_2425" | "net_2526" | "net_change" | "off_o" | "off_d" | "off_net" | "pre_ortg" | "pre_drtg" | "pre_net" | NumField;

const ALL_TEAMS = Array.from(new Set(Object.values(TEAM_NAME_BY_ABBR))).sort();

// Kuluvan kauden (26-27) runkosarjan luvut pelatuista otteluista (schedule-taulu,
// päivittyy päivittäin cronilla). ORTG/DRTG = otteluiden arvot painotettuna
// hallintojen määrällä (pace), Net = ORTG − DRTG.
type CurStats = { gp: number; w: number; l: number; ortg: number | null; drtg: number | null; pace: number | null; net: number | null; l10: number | null };
const CUR_SEASON_START = "2026-10-15";

function currentSeason(games: any[]): Record<string, CurStats> {
  const per: Record<string, { w: number; l: number; rows: { date: string; o: number; d: number; p: number }[] }> = {};
  const get = (t: string) => (per[t] ??= { w: 0, l: 0, rows: [] });
  for (const g of games) {
    if (g.season_type === "pre" || String(g.date) < CUR_SEASON_START) continue;
    if (g.home_score == null || g.away_score == null) continue;
    const hs = Number(g.home_score), as = Number(g.away_score);
    const h = get(g.home), a = get(g.away);
    if (hs > as) { h.w++; a.l++; } else { a.w++; h.l++; }
    if (g.home_ortg != null && g.home_drtg != null && g.home_pace != null) {
      h.rows.push({ date: g.date, o: Number(g.home_ortg), d: Number(g.home_drtg), p: Number(g.home_pace) });
    }
    if (g.away_ortg != null && g.away_drtg != null && g.away_pace != null) {
      a.rows.push({ date: g.date, o: Number(g.away_ortg), d: Number(g.away_drtg), p: Number(g.away_pace || g.home_pace) });
    }
  }
  const out: Record<string, CurStats> = {};
  for (const [t, v] of Object.entries(per)) {
    const rs = v.rows.sort((x, y) => x.date.localeCompare(y.date));
    const agg = (xs: typeof rs) => {
      const P = xs.reduce((s, r) => s + r.p, 0);
      if (!xs.length || P <= 0) return null;
      const o = xs.reduce((s, r) => s + r.o * r.p, 0) / P;
      const d = xs.reduce((s, r) => s + r.d * r.p, 0) / P;
      return { o, d, p: P / xs.length };
    };
    const all = agg(rs);
    const last = agg(rs.slice(-10));
    out[t] = {
      gp: v.w + v.l,
      w: v.w,
      l: v.l,
      ortg: all?.o ?? null,
      drtg: all?.d ?? null,
      pace: all?.p ?? null,
      net: all ? all.o - all.d : null,
      l10: last ? last.o - last.d : null,
    };
  }
  return out;
}

function emptyRow(team: string): TeamStats {
  return {
    team,
    pace_2425: null,
    ortg_2425: null,
    drtg_2425: null,
    pace_2526: null,
    ortg_2526: null,
    drtg_2526: null,
    coach_change: false,
    home_adv: null,
    win_total: null,
    wt_line: null,
    wt_over: null,
    wt_under: null,
  };
}

function net(o: number | null, d: number | null): number | null {
  if (o == null || d == null) return null;
  return o - d;
}

function sortValue(row: TeamStats, key: SortKey): number | string | null {
  if (key === "team") return row.team;
  if (key === "net_2425") return net(row.ortg_2425, row.drtg_2425);
  if (key === "net_2526") return net(row.ortg_2526, row.drtg_2526);
  if (key === "net_change") {
    const a = net(row.ortg_2425, row.drtg_2425);
    const b = net(row.ortg_2526, row.drtg_2526);
    return a == null || b == null ? null : b - a;
  }
  return row[key];
}

// Muokattava luku: näyttää arvon, muokkaus vahvistetaan Enterillä tai kentästä poistuttaessa.
function EditCell({ value, changed, onCommit }: { value: number | null; changed: boolean; onCommit: (v: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = draft ?? (value == null ? "" : value.toFixed(1));
  const commit = () => {
    if (draft != null) {
      const v = Number(draft.replace(",", "."));
      if (draft.trim() !== "" && Number.isFinite(v)) onCommit(v);
    }
    setDraft(null);
  };
  return (
    <td style={{ padding: 2 }}>
      <input
        value={shown}
        disabled={value == null}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setDraft(null);
        }}
        style={{
          width: 54,
          background: "#1e293b",
          color: changed ? "#fbbf24" : "#e2e8f0",
          border: `1px solid ${changed ? "#b45309" : "#334155"}`,
          borderRadius: 4,
          padding: "4px 6px",
          fontSize: 12,
          fontWeight: 600,
          textAlign: "right",
        }}
      />
    </td>
  );
}

export default function TeamsPage() {
  const [secret, setSecret] = useState("");
  const [rows, setRows] = useState<Record<string, TeamStats>>({});
  // Tallennetut arvot — järjestys lasketaan näistä, jotta rivi ei hypi
  // kesken kirjoittamisen.
  const [saved, setSaved] = useState<Record<string, TeamStats>>({});
  const [loading, setLoading] = useState(true);
  const [savingTeam, setSavingTeam] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("m_net");
  const [cur, setCur] = useState<Record<string, CurStats>>({});
  // Matchupin käyttämät mallin luvut (samat asetukset kuin Matchupissa).
  const [games, setGames] = useState<any[]>([]);
  const [transactions, setTransactions] = useState<TxRow[]>([]);
  const [alphas, setAlphas] = useState({ alpha: 0.05, paceAlpha: 0.08 });
  const [ortgShift, setOrtgShift] = useState(0);
  const [shiftDraft, setShiftDraft] = useState<string | null>(null);
  const [shiftMsg, setShiftMsg] = useState<string | null>(null);
  // Kesän muutos ja preseason 26-27 (sama laskenta ja asetukset kuin Matchupissa).
  const [players, setPlayers] = useState<any[]>([]);
  const [prevRows, setPrevRows] = useState<PrevRow[]>([]);
  const [preSettings, setPreSettings] = useState<PreSettings>(DEFAULT_PRE_SETTINGS);
  const [sortDesc, setSortDesc] = useState(true);

  useEffect(() => {
    setSecret(localStorage.getItem("cron_secret") ?? "");
    setPreSettings(loadPreSettings());
    loadPreSettingsRemote().then(setPreSettings);
    load();
    (async () => {
      try {
        const [pj, rj, sj, tj, stj] = await Promise.all([
          fetch("/api/players/import").then((r) => r.json()),
          fetch("/api/prev-season").then((r) => r.json()),
          fetch("/api/schedule", { cache: "no-store" }).then((r) => r.json()).catch(() => ({ games: [] })),
          fetch("/api/transactions").then((r) => r.json()).catch(() => ({ transactions: [] })),
          fetch("/api/settings").then((r) => r.json()).catch(() => ({ settings: {} })),
        ]);
        setCur(currentSeason(sj.games ?? []));
        setGames(sj.games ?? []);
        setTransactions(tj.transactions ?? []);
        const m = stj?.settings?.model ?? {};
        setAlphas({
          alpha: typeof m.alpha === "number" ? m.alpha : 0.05,
          paceAlpha: typeof m.paceAlpha === "number" ? m.paceAlpha : 0.08,
        });
        const sh = Number(stj?.settings?.efficiency?.ortgShift);
        setOrtgShift(Number.isFinite(sh) ? sh : 0);
        setPlayers(
          (pj.players ?? []).map((p: any) => ({
            ...p,
            oepm: Number(p.oepm) || 0,
            depm: Number(p.depm) || 0,
            mpg_base: Number(p.mpg_base) || 0,
            active: p.active !== false,
          }))
        );
        setPrevRows((rj.rows ?? []).map((r: any) => ({ ...r, gp: Number(r.gp) || 0, min_total: Number(r.min_total) || 0 })));
      } catch {
        // ei haittaa — sarakkeet jäävät tyhjiksi
      }
    })();
  }, []);

  async function load() {
    setLoading(true);
    try {
      const res = await fetch("/api/team-stats");
      const data = await res.json();
      const byTeam: Record<string, TeamStats> = {};
      for (const t of ALL_TEAMS) byTeam[t] = emptyRow(t);
      for (const row of data.teams ?? []) {
        byTeam[row.team] = { ...emptyRow(row.team), ...row };
      }
      setRows(byTeam);
      setSaved(byTeam);
    } catch {
      // ei haittaa
    } finally {
      setLoading(false);
    }
  }

  function updateField(team: string, field: keyof TeamStats, value: any) {
    setRows((prev) => ({ ...prev, [team]: { ...prev[team], [field]: value } }));
  }

  async function saveTeam(team: string) {
    setSavingTeam(team);
    setStatus(null);
    localStorage.setItem("cron_secret", secret);
    const row = rows[team];
    try {
      const res = await fetch("/api/team-stats", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(row),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Virhe (${team}): ${data.error ?? "tuntematon virhe"}`);
      } else {
        setStatus(`${team} tallennettu.`);
        setSaved((prev) => ({ ...prev, [team]: row }));
      }
    } catch (e: any) {
      setStatus(`Virhe (${team}): ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setSavingTeam(null);
    }
  }

  function clickSort(key: SortKey) {
    if (key === sortKey) {
      setSortDesc((d) => !d);
    } else {
      setSortKey(key);
      // Nimi A-Ö nousevasti, luvut oletuksena suurin ensin — paitsi DRTG, jossa
      // pienin (paras puolustus) ensin.
      setSortDesc(key !== "team" && !key.startsWith("drtg") && key !== "pre_drtg" && key !== "cur_drtg" && key !== "m_drtg");
    }
  }

  const pre = useMemo(() => {
    const ts = Object.values(saved).filter((t) => t.ortg_2526 != null || t.ortg_2425 != null);
    if (ts.length === 0 || players.length === 0) return null;
    return computePreseason(ts, withRatings(players, preSettings.ratingSource ?? "avg"), prevRows, preSettings, undefined, games.length ? games : undefined);
  }, [saved, players, prevRows, preSettings, games]);

  // Mallin luvut ilman käsin säätöä (sama laskenta kuin Matchupissa, ilman ottelukohtaista kokoonpanoa).
  const modelBase = useMemo(() => {
    if (!pre) return {} as Record<string, { gp: number; o: number; d: number; p: number }>;
    const byTeam = gamesByTeamFrom(games);
    const seasonStart = seasonStartFrom(games);
    const today = new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
    const out: Record<string, { gp: number; o: number; d: number; p: number }> = {};
    for (const t of ALL_TEAMS) {
      const pr = pre.byTeam[t];
      if (!pr) continue;
      const tm = teamModelFor(t, pr, {
        played: byTeam[t] ?? [],
        transactions,
        alpha: alphas.alpha,
        paceAlpha: alphas.paceAlpha,
        usePrev: prevRows.length > 0,
        seasonStart,
        refDate: today,
      });
      out[t] = { gp: tm.gamesPlayed, o: tm.modelOrtg, d: tm.modelDrtg, p: tm.paceActual };
    }
    return out;
  }, [pre, games, transactions, alphas, prevRows]);
  // Lopullinen luku = malli + säätö. rowsFrom = tallennetut (järjestys) tai muokatut (näyttö).
  const modelVal = (team: string, key: ModelKey, src: Record<string, TeamStats> = rows): number | null => {
    const b = modelBase[team];
    if (!b) return null;
    const r = src[team];
    const o = b.o + (Number(r?.adj_ortg) || 0);
    const d = b.d + (Number(r?.adj_drtg) || 0);
    if (key === "m_ortg") return o;
    if (key === "m_drtg") return d;
    if (key === "m_net") return o - d;
    if (key === "m_pace") return b.p + (Number(r?.adj_pace) || 0);
    return null;
  };
  // Liigan toteutunut ORTG vs. mallin keskiarvo (totalien taso).
  const levelCheck = useMemo(() => {
    let P = 0, OP = 0, n = 0;
    for (const c of Object.values(cur)) {
      if (c.ortg == null || c.pace == null) continue;
      P += c.pace * c.gp;
      OP += c.ortg * c.pace * c.gp;
      n += c.gp;
    }
    const ms = Object.values(modelBase);
    if (!n || !ms.length) return null;
    const modelO = ms.reduce((s, m) => s + (m.o + m.d) / 2, 0) / ms.length;
    const modelPace = ms.reduce((s, m) => s + m.p, 0) / ms.length;
    const actualPace = Object.values(cur).filter((c) => c.pace != null).reduce((s, c) => s + (c.pace as number) * c.gp, 0) / n;
    return { actual: OP / P, model: modelO, modelPace, actualPace };
  }, [cur, modelBase]);
  async function saveShift(v: number) {
    setShiftMsg(null);
    if (!secret) {
      setShiftMsg("Tallennus vaatii CRON_SECRETin.");
      return;
    }
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ key: "efficiency", value: { ortgShift: v } }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) setShiftMsg(`Virhe: ${j.error ?? res.status}`);
      else {
        setOrtgShift(v);
        setShiftMsg("Tallennettu — Matchup käyttää tätä.");
      }
    } catch (e: any) {
      setShiftMsg(`Virhe: ${e?.message ?? e}`);
    }
  }
  const preVal = (team: string, key: SortKey): number | null => {
    const p = pre?.byTeam[team];
    if (!p) return null;
    if (key === "off_o") return p.offO;
    if (key === "off_d") return p.offD;
    if (key === "off_net") return p.offO + p.offD;
    // Kauden keskitaso: tunnetut pitkät poissaolot (arvioitu paluupäivä) vähennetty.
    if (key === "pre_ortg") return p.ortg - p.availO;
    if (key === "pre_drtg") return p.drtg + p.availD;
    if (key === "pre_net") return p.seasonNet;
    return null;
  };
  const curVal = (team: string, key: CurKey): number | null => {
    const c = cur[team];
    if (!c || c.gp === 0) return null;
    if (key === "cur_gp") return c.gp;
    if (key === "cur_wpct") return c.w / c.gp;
    if (key === "cur_net") return c.net;
    if (key === "cur_ortg") return c.ortg;
    if (key === "cur_drtg") return c.drtg;
    if (key === "cur_pace") return c.pace;
    if (key === "cur_l10") return c.l10;
    if (key === "cur_vs_pre") {
      const pn = preVal(team, "pre_net");
      return c.net == null || pn == null ? null : c.net - pn;
    }
    return null;
  };
  const curGames = Object.values(cur).reduce((s, c) => s + c.gp, 0) / 2;

  // Järjestys lasketaan tallennetuista arvoista; tyhjät aina viimeiseksi.
  const sortedTeams = useMemo(() => {
    const list = ALL_TEAMS.map((t) => saved[t] ?? emptyRow(t));
    const val = (r: TeamStats, k: SortKey) =>
      k.startsWith("m_")
        ? modelVal(r.team, k as ModelKey, saved)
        : k.startsWith("cur_") ? curVal(r.team, k as CurKey) : k.startsWith("off_") || k.startsWith("pre_") ? preVal(r.team, k) : sortValue(r, k);
    return list.sort((a, b) => {
      const va = val(a, sortKey);
      const vb = val(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDesc ? -cmp : cmp;
    });
  }, [saved, sortKey, sortDesc, pre, cur, modelBase]);

  const inputStyle = {
    width: 60,
    background: "#1e293b",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 4,
    padding: "4px 6px",
    fontSize: 12,
  };

  function SortHeader({ k, label, title }: { k: SortKey; label: string; title?: string }) {
    const active = sortKey === k;
    return (
      <th
        onClick={() => clickSort(k)}
        title={title ?? "Järjestä tämän mukaan"}
        style={{
          padding: "6px 4px",
          cursor: "pointer",
          userSelect: "none",
          whiteSpace: "nowrap",
          color: active ? "#e2e8f0" : "#94a3b8",
        }}
      >
        {label}
        <span style={{ marginLeft: 3, fontSize: 10, color: active ? "#60a5fa" : "#475569" }}>
          {active ? (sortDesc ? "▼" : "▲") : "↕"}
        </span>
      </th>
    );
  }

  function numInput(team: string, field: NumField, value: number | null) {
    return (
      <td style={{ padding: 2 }}>
        <input
          type="number"
          value={value ?? ""}
          onChange={(e) => updateField(team, field, e.target.value === "" ? null : Number(e.target.value))}
          style={inputStyle}
        />
      </td>
    );
  }

  function netCell(v: number | null, bold = false) {
    return (
      <td
        style={{
          padding: "2px 8px",
          textAlign: "right",
          fontWeight: bold ? 700 : 600,
          fontVariantNumeric: "tabular-nums",
          color: v == null ? "#475569" : v >= 0 ? "#4ade80" : "#f87171",
          background: "#111827",
        }}
      >
        {v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(1)}`}
      </td>
    );
  }

  function plainCell(v: number | null) {
    return (
      <td style={{ padding: "2px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: v == null ? "#475569" : "#cbd5e1" }}>
        {v == null ? "—" : v.toFixed(1)}
      </td>
    );
  }
  function deltaCell(v: number | null, bold = false) {
    return (
      <td
        style={{
          padding: "2px 6px",
          textAlign: "right",
          fontVariantNumeric: "tabular-nums",
          fontWeight: bold ? 700 : 400,
          color: v == null ? "#475569" : Math.abs(v) < 0.05 ? "#64748b" : v > 0 ? "#4ade80" : "#f87171",
        }}
      >
        {v == null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`}
      </td>
    );
  }

  const groupHead = { padding: "4px", fontSize: 11, color: "#64748b", textAlign: "center" as const, borderBottom: "1px solid #1e293b" };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Teams</h1>
      <p style={{ color: "#64748b", fontSize: 13, margin: "8px 0 20px", maxWidth: 760 }}>
        Matchup-laskurin pohjaluvut: molempien kausien ORTG/DRTG/Pace, &quot;Coach vaihtui&quot;-lippu (käyttää
        vain 25-26 dataa) ja kotietu (HCA, pistettä). Net Rating = ORTG − DRTG lasketaan automaattisesti. Klikkaa
        sarakkeen otsikkoa järjestääksesi. Tallenna muutokset rivi kerrallaan.
      </p>
      <div style={{ fontSize: 12, color: "#64748b", margin: "-8px 0 16px", maxWidth: 900, lineHeight: 1.6 }}>
        <strong style={{ color: "#fbbf24" }}>Kausi 26-27</strong> = toteutuneet runkosarjan luvut pelatuista otteluista (
        {Math.round(curGames)} ottelua; päivittyy päivittäin). ORTG/DRTG painotettu hallinnoilla. <strong>L10</strong> = viimeisen 10
        ottelun Net, <strong>vs. pre</strong> = toteutunut Net − Preseason-Net (+ = parempi kuin lähtötaso).{" "}
        <strong style={{ color: "#93c5fd" }}>Preseason 26-27</strong> = joukkueen lähtötaso ensimmäiseen otteluun: kausiblendi, regressio
        (pelaajat {preSettings.carry.player} % · jäännös {preSettings.carry.res} %), kesän muutos Transactionsista
        {preSettings.leagueNorm ? " (liigakeskiarvo vähennetty)" : ""}
        {preSettings.marketWeight > 0 ? ` ja win totalit ${preSettings.marketWeight} %` : ""}. Asetukset tulevat Matchupista
        (tallennettu tietokantaan). <strong>Kesän muutos</strong> on pelaajakertoimella ({preSettings.carry.player} %) skaalattu, D positiivinen = parempi
        puolustus. Pelattujen otteluiden EWMA ei ole mukana.
        {!pre && " Ladataan pelaajia..."}
      </div>

      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontSize: 12, color: "#94a3b8" }}>CRON_SECRET</label>
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        {status && (
          <span style={{ fontSize: 12, color: status.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>{status}</span>
        )}
      </div>

      <div
        style={{
          marginBottom: 16,
          padding: "10px 12px",
          background: "#111827",
          border: "1px solid #1e293b",
          borderRadius: 6,
          fontSize: 12,
          color: "#94a3b8",
          maxWidth: 900,
          lineHeight: 1.6,
        }}
      >
        <strong style={{ color: "#f472b6" }}>Malli nyt</strong> = luvut, joita Matchup-laskuri käyttää ennen ottelukohtaista
        kokoonpanoa: lähtötaso → EWMA pelatuista (α {alphas.alpha.toFixed(2)}, pace-α {alphas.paceAlpha.toFixed(2)}) → kauden
        siirrot → <strong>käsin säätö</strong> (liigan tehokkuussäätö lisätään Matchupissa vielä kaikkien ORTG:hen). Muokkaa ORTG/DRTG/Pace suoraan (Enter) ja paina rivin Tallenna; muokattu luku tallentuu
        säätönä mallin päälle, joten se liikkuu edelleen pelien mukana. Keltainen = säädetty. Trendin painoa (α) muutetaan
        Matchupin asetuksista.
        <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <span style={{ color: "#e2e8f0" }}>Liigan tehokkuussäätö (ORTG kaikille, p/100):</span>
          <input
            value={shiftDraft ?? String(ortgShift)}
            onChange={(e) => setShiftDraft(e.target.value)}
            style={{ ...inputStyle, width: 56 }}
          />
          <button
            onClick={() => {
              const v = Number((shiftDraft ?? String(ortgShift)).replace(",", "."));
              if (Number.isFinite(v)) saveShift(Math.max(-10, Math.min(10, Math.round(v * 10) / 10)));
              setShiftDraft(null);
            }}
            style={{ background: "#2563eb", color: "white", border: "none", borderRadius: 4, padding: "4px 10px", fontSize: 11, cursor: "pointer" }}
          >
            Tallenna
          </button>
          {shiftMsg && <span style={{ color: shiftMsg.startsWith("Virhe") || shiftMsg.startsWith("Tallennus") ? "#f87171" : "#4ade80" }}>{shiftMsg}</span>}
          <span>
            Muuttaa totaleita (≈ 2 × säätö), ei tasoituksia. Esim. −1.0 laskee jokaisen ottelun totalia noin 2 pistettä.
          </span>
        </div>
        {levelCheck && (
          <div style={{ marginTop: 6 }}>
            Toteutunut liigan ORTG 26-27: <strong style={{ color: "#e2e8f0" }}>{levelCheck.actual.toFixed(1)}</strong> · mallin
            keskitaso (ilman säätöä): <strong style={{ color: "#e2e8f0" }}>{levelCheck.model.toFixed(1)}</strong> · ero{" "}
            <strong style={{ color: levelCheck.actual - levelCheck.model < 0 ? "#f87171" : "#4ade80" }}>
              {levelCheck.actual - levelCheck.model > 0 ? "+" : ""}
              {(levelCheck.actual - levelCheck.model).toFixed(1)}
            </strong>
            . Tempo: toteutunut {levelCheck.actualPace.toFixed(1)} · malli {levelCheck.modelPace.toFixed(1)}.
          </div>
        )}
      </div>

      {!loading && players.length > 0 && (
        <SourceCompare teams={Object.values(saved) as any} players={players} prevRows={prevRows} settings={preSettings} secret={secret} />
      )}
      {loading ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ladataan...</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th />
                <th />
                <th colSpan={6} style={{ ...groupHead, color: "#f472b6" }}>
                  Malli nyt (Matchup käyttää)
                </th>
                <th colSpan={8} style={{ ...groupHead, color: "#fbbf24" }}>
                  Kausi 26-27 (toteutunut)
                </th>
                <th colSpan={3} style={{ ...groupHead, color: "#93c5fd" }}>
                  Preseason 26-27
                </th>
                <th colSpan={3} style={groupHead}>
                  Kesän muutos
                </th>
                <th colSpan={4} style={groupHead}>
                  Kausi 25-26
                </th>
                <th colSpan={4} style={groupHead}>
                  Kausi 24-25
                </th>
                <th />
                <th colSpan={4} />
              </tr>
              <tr style={{ textAlign: "left" }}>
                <th style={{ padding: "6px 4px", color: "#64748b" }}>#</th>
                <SortHeader k="team" label="Joukkue" />
                <SortHeader k="m_net" label="Net" title="Mallin Net (ORTG − DRTG), säädöt mukana" />
                <SortHeader k="m_ortg" label="ORTG" title="Muokattava — tallentuu säätönä mallin päälle" />
                <SortHeader k="m_drtg" label="DRTG" title="Muokattava — tallentuu säätönä mallin päälle" />
                <SortHeader k="m_pace" label="Pace" title="Muokattava — tallentuu säätönä mallin päälle" />
                <th style={{ padding: "6px 4px", color: "#94a3b8", whiteSpace: "nowrap" }} title="Käsin säätö O / D / Pace (D: + = huonompi puolustus)">
                  Säätö
                </th>
                <th />
                <SortHeader k="cur_wpct" label="V–H" title="Voitot–häviöt (järjestys voitto-%)" />
                <SortHeader k="cur_net" label="Net" title="Toteutunut Net Rating 26-27 (ORTG − DRTG)" />
                <SortHeader k="cur_ortg" label="ORTG" />
                <SortHeader k="cur_drtg" label="DRTG" />
                <SortHeader k="cur_pace" label="Pace" />
                <SortHeader k="cur_l10" label="L10" title="Viimeisen 10 ottelun Net Rating" />
                <SortHeader k="cur_vs_pre" label="vs. pre" title="Toteutunut Net − Preseason-Net" />
                <SortHeader k="cur_gp" label="GP" />
                <SortHeader k="pre_net" label="Net" title="Kauden 26-27 keskitaso: regressio + kesän muutos (+ win total -paino) − tunnetut pitkät poissaolot (poissa-merkintä ja arvioitu paluupäivä Matchupissa; minuutit korvaavan tason pelaajalle)" />
                <SortHeader k="pre_ortg" label="ORTG" />
                <SortHeader k="pre_drtg" label="DRTG" />
                <SortHeader k="off_o" label="O" title="Kesän muutos hyökkäykseen (Transactions: rosteri nyt − 25-26 pohja)" />
                <SortHeader k="off_d" label="D" title="Kesän muutos puolustukseen (+ = parempi puolustus)" />
                <SortHeader k="off_net" label="Net" title="Kesän muutos yhteensä" />
                <SortHeader k="net_2526" label="Net" title="Net Rating 25-26 (ORTG − DRTG)" />
                <SortHeader k="ortg_2526" label="ORTG" />
                <SortHeader k="drtg_2526" label="DRTG" />
                <SortHeader k="pace_2526" label="Pace" />
                <SortHeader k="net_2425" label="Net" title="Net Rating 24-25 (ORTG − DRTG)" />
                <SortHeader k="ortg_2425" label="ORTG" />
                <SortHeader k="drtg_2425" label="DRTG" />
                <SortHeader k="pace_2425" label="Pace" />
                <SortHeader k="net_change" label="Δ Net" title="Net Ratingin muutos 24-25 → 25-26" />
                <th style={{ padding: "6px 4px", color: "#94a3b8" }}>Coach</th>
                <SortHeader k="home_adv" label="HCA" />
                <SortHeader k="win_total" label="Odot. voitot" title="Markkinan odotetut voitot 26-27 (linjasta ja kertoimista, marginaali poistettu). Malli kalibroidaan ja blendataan näihin." />
                <SortHeader k="wt_line" label="Linja" title="Vedonlyöntilinja (Kausi-sivun EV lasketaan tätä vastaan)" />
                <SortHeader k="wt_over" label="Yli" title="Kerroin yli" />
                <SortHeader k="wt_under" label="Alle" title="Kerroin alle" />
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedTeams.map((savedRow, i) => {
                const team = savedRow.team;
                const row = rows[team] ?? savedRow;
                const n2526 = net(row.ortg_2526, row.drtg_2526);
                const n2425 = net(row.ortg_2425, row.drtg_2425);
                const change = n2526 == null || n2425 == null ? null : n2526 - n2425;
                return (
                  <tr key={team} style={{ borderTop: "1px solid #1e293b" }}>
                    <td style={{ padding: 4, color: "#475569", textAlign: "right" }}>{i + 1}</td>
                    <td style={{ padding: 4, whiteSpace: "nowrap" }}>{team}</td>
                    {netCell(modelVal(team, "m_net"), true)}
                    <EditCell
                      value={modelVal(team, "m_ortg")}
                      changed={!!Number(row.adj_ortg)}
                      onCommit={(v) => updateField(team, "adj_ortg", Math.round((v - (modelBase[team]?.o ?? v)) * 10) / 10)}
                    />
                    <EditCell
                      value={modelVal(team, "m_drtg")}
                      changed={!!Number(row.adj_drtg)}
                      onCommit={(v) => updateField(team, "adj_drtg", Math.round((v - (modelBase[team]?.d ?? v)) * 10) / 10)}
                    />
                    <EditCell
                      value={modelVal(team, "m_pace")}
                      changed={!!Number(row.adj_pace)}
                      onCommit={(v) => updateField(team, "adj_pace", Math.round((v - (modelBase[team]?.p ?? v)) * 10) / 10)}
                    />
                    <td style={{ padding: "2px 6px", whiteSpace: "nowrap", fontSize: 11, color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
                      {Number(row.adj_ortg) || Number(row.adj_drtg) || Number(row.adj_pace) ? (
                        <>
                          <span style={{ color: "#fbbf24" }}>
                            {[row.adj_ortg, row.adj_drtg, row.adj_pace].map((x) => `${(Number(x) || 0) > 0 ? "+" : ""}${(Number(x) || 0).toFixed(1)}`).join(" / ")}
                          </span>
                          <button
                            onClick={() => {
                              updateField(team, "adj_ortg", 0);
                              updateField(team, "adj_drtg", 0);
                              updateField(team, "adj_pace", 0);
                            }}
                            title="Nollaa säätö (muista Tallenna)"
                            style={{ marginLeft: 4, background: "none", border: "1px solid #334155", color: "#94a3b8", borderRadius: 3, fontSize: 10, cursor: "pointer", padding: "0 4px" }}
                          >
                            ×
                          </button>
                        </>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td style={{ padding: 2 }}>
                      <button
                        onClick={() => saveTeam(team)}
                        disabled={savingTeam === team || !secret}
                        style={{
                          background: savingTeam === team || !secret ? "#334155" : "#2563eb",
                          color: "white",
                          border: "none",
                          borderRadius: 4,
                          padding: "4px 8px",
                          fontSize: 11,
                          cursor: savingTeam === team || !secret ? "not-allowed" : "pointer",
                        }}
                      >
                        {savingTeam === team ? "..." : "Tallenna"}
                      </button>
                    </td>
                    <td style={{ padding: "2px 8px", textAlign: "right", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", color: "#cbd5e1" }}>
                      {cur[team] ? `${cur[team].w}–${cur[team].l}` : "—"}
                    </td>
                    {netCell(curVal(team, "cur_net"), true)}
                    {plainCell(curVal(team, "cur_ortg"))}
                    {plainCell(curVal(team, "cur_drtg"))}
                    {plainCell(curVal(team, "cur_pace"))}
                    {netCell(curVal(team, "cur_l10"))}
                    {deltaCell(curVal(team, "cur_vs_pre"))}
                    <td style={{ padding: "2px 6px", textAlign: "right", color: "#64748b" }}>{cur[team]?.gp ?? 0}</td>
                    {netCell(preVal(team, "pre_net"), true)}
                    {plainCell(preVal(team, "pre_ortg"))}
                    {plainCell(preVal(team, "pre_drtg"))}
                    {deltaCell(preVal(team, "off_o"))}
                    {deltaCell(preVal(team, "off_d"))}
                    {deltaCell(preVal(team, "off_net"), true)}
                    {netCell(n2526, true)}
                    {numInput(team, "ortg_2526", row.ortg_2526)}
                    {numInput(team, "drtg_2526", row.drtg_2526)}
                    {numInput(team, "pace_2526", row.pace_2526)}
                    {netCell(n2425)}
                    {numInput(team, "ortg_2425", row.ortg_2425)}
                    {numInput(team, "drtg_2425", row.drtg_2425)}
                    {numInput(team, "pace_2425", row.pace_2425)}
                    <td
                      style={{
                        padding: "2px 8px",
                        textAlign: "right",
                        fontVariantNumeric: "tabular-nums",
                        color: change == null ? "#475569" : change >= 0 ? "#4ade80" : "#f87171",
                      }}
                    >
                      {change == null ? "—" : `${change > 0 ? "+" : ""}${change.toFixed(1)}`}
                    </td>
                    <td style={{ padding: 4, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={!!row.coach_change}
                        onChange={(e) => updateField(team, "coach_change", e.target.checked)}
                      />
                    </td>
                    {numInput(team, "home_adv", row.home_adv)}
                    {numInput(team, "win_total", row.win_total)}
                    {numInput(team, "wt_line", row.wt_line ?? null)}
                    {numInput(team, "wt_over", row.wt_over ?? null)}
                    {numInput(team, "wt_under", row.wt_under ?? null)}
                    <td style={{ padding: 2 }}>
                      <button
                        onClick={() => saveTeam(team)}
                        disabled={savingTeam === team || !secret}
                        style={{
                          background: savingTeam === team || !secret ? "#334155" : "#2563eb",
                          color: "white",
                          border: "none",
                          borderRadius: 4,
                          padding: "4px 10px",
                          fontSize: 11,
                          cursor: savingTeam === team || !secret ? "not-allowed" : "pointer",
                        }}
                      >
                        {savingTeam === team ? "..." : "Tallenna"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
