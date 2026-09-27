"use client";

import { Fragment, useEffect, useMemo, useState } from "react";
import {
  parsePlayersPaste,
  parseEpmSitePaste,
  parseEpmLeaguePaste,
  type ParsedPlayer,
  type SiteParsedPlayer,
  type LeaguePlayer,
} from "@/lib/parsePlayers";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";
import { normalizePlayerName } from "@/lib/parseTransactions";
import { computeRosterChange, makePlayerFinder, canonTeam, type StartRow } from "@/lib/prevSeason";

type DbPlayer = ParsedPlayer & { id: string; updated_at: string };

const ALL_TEAMS = Array.from(new Set(Object.values(TEAM_NAME_BY_ABBR))).sort();
const LEAGUE_ACCUMULATOR_KEY = "epm_league_accumulator_v1";

export default function PlayersPage() {
  const [tab, setTab] = useState<"excel" | "site" | "league" | "manual" | "prev">("excel");

  // --- Alkutilanne (season_start_roster = Excelin rosterit ja minuutit) ---
  const [prevRows, setPrevRows] = useState<StartRow[]>([]);
  const [prevLoaded, setPrevLoaded] = useState(false);
  const [prevStatus, setPrevStatus] = useState<string | null>(null);
  const [prevOpenTeam, setPrevOpenTeam] = useState<string | null>(null);
  const [startEdit, setStartEdit] = useState<Record<string, string>>({});
  async function loadPrevRows() {
    try {
      const res = await fetch("/api/season-start");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setPrevStatus(`Virhe: ${data.error ?? res.status}`);
      setPrevRows((data.rows ?? []).map((r: any) => ({ ...r, mpg: Number(r.mpg) || 0, oepm: Number(r.oepm) || 0, depm: Number(r.depm) || 0 })));
    } catch (e: any) {
      setPrevStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setPrevLoaded(true);
    }
  }
  async function saveStartMinutes(row: StartRow) {
    const raw = startEdit[row.id!];
    if (raw == null) return;
    const mpg = Number(raw.replace(",", "."));
    if (!Number.isFinite(mpg) || mpg < 0 || mpg > 48 || mpg === Number(row.mpg)) {
      setStartEdit((e) => {
        const n = { ...e };
        delete n[row.id!];
        return n;
      });
      return;
    }
    localStorage.setItem("cron_secret", secret);
    const res = await fetch("/api/season-start", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ id: row.id, mpg }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      setPrevStatus(`Virhe: ${data.error ?? res.status}`);
      return;
    }
    setPrevStatus(`Tallennettu: ${row.name} alkutilanne ${mpg} min.`);
    setPrevRows((rows) => rows.map((r) => (r.id === row.id ? { ...r, mpg } : r)));
    setStartEdit((e) => {
      const n = { ...e };
      delete n[row.id!];
      return n;
    });
  }

  // --- Käsin lisäys (esim. tulokkaat joita ei vielä ole EPM-sivulla) ---
  const [manName, setManName] = useState("");
  const [manTeam, setManTeam] = useState(ALL_TEAMS[0] ?? "");
  const [manPos, setManPos] = useState("");
  const [manMpg, setManMpg] = useState<number>(15);
  const [manO, setManO] = useState<number>(-1.5);
  const [manD, setManD] = useState<number>(-1.0);
  const [manActive, setManActive] = useState(true);
  const [manSaving, setManSaving] = useState(false);
  const [manStatus, setManStatus] = useState<string | null>(null);

  // --- Pelaajakuvat (nba_id-synkronointi) ---
  const [syncing, setSyncing] = useState(false);
  const [syncStatus, setSyncStatus] = useState<string | null>(null);

  async function handleSyncIds() {
    setSyncing(true);
    setSyncStatus(null);
    localStorage.setItem("cron_secret", secret);
    try {
      const res = await fetch("/api/players/sync-ids", {
        method: "POST",
        headers: { Authorization: `Bearer ${secret}` },
      });
      const data = await res.json().catch(() => ({ error: `palvelin vastasi ${res.status} (aikakatkaisu tai kaatuminen)` }));
      if (!res.ok) {
        setSyncStatus(`Virhe: ${data.error ?? res.status}`);
      } else {
        const miss: string[] = data.unmatched ?? [];
        setSyncStatus(
          `Päivitetty ${data.updated} pelaajaa.` +
            (miss.length ? ` Ei löytynyt (${miss.length}): ${miss.slice(0, 15).join(", ")}${miss.length > 15 ? "…" : ""}` : "")
        );
        await loadCurrent();
      }
    } catch (e: any) {
      setSyncStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setSyncing(false);
    }
  }

  // --- Site-tuonnin "puuttuu liitteestä" -poistovalinnat ---
  const [siteRemove, setSiteRemove] = useState<Set<string>>(new Set());

  // --- Yhteinen ---
  const [secret, setSecret] = useState("");
  const [current, setCurrent] = useState<DbPlayer[]>([]);
  const [loadingCurrent, setLoadingCurrent] = useState(true);

  // --- Excel-tuonti (koko roster) ---
  const [raw, setRaw] = useState("");
  const [preview, setPreview] = useState<ParsedPlayer[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [status, setStatus] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- Site-tuonti (yksi joukkue kerrallaan) ---
  const [siteTeam, setSiteTeam] = useState(ALL_TEAMS[0] ?? "");
  const [siteRaw, setSiteRaw] = useState("");
  const [sitePreview, setSitePreview] = useState<SiteParsedPlayer[]>([]);
  const [siteWarnings, setSiteWarnings] = useState<string[]>([]);
  const [siteStatus, setSiteStatus] = useState<string | null>(null);
  const [siteSaving, setSiteSaving] = useState(false);

  // --- EPM koko liiga (kertyvä, useampi liite) ---
  const [leagueRaw, setLeagueRaw] = useState("");
  const [leagueWarnings, setLeagueWarnings] = useState<string[]>([]);
  const [leagueAcc, setLeagueAcc] = useState<Record<string, LeaguePlayer>>({});
  const [leagueStatus, setLeagueStatus] = useState<string | null>(null);
  const [leagueSaving, setLeagueSaving] = useState(false);

  useEffect(() => {
    const savedSecret = localStorage.getItem("cron_secret") ?? "";
    setSecret(savedSecret);
    loadCurrent();
    loadPrevRows();
    try {
      const saved = localStorage.getItem(LEAGUE_ACCUMULATOR_KEY);
      if (saved) setLeagueAcc(JSON.parse(saved));
    } catch {
      // ei haittaa, aloitetaan tyhjästä
    }
  }, []);

  async function loadCurrent() {
    setLoadingCurrent(true);
    try {
      const res = await fetch("/api/players/import");
      const data = await res.json();
      setCurrent(data.players ?? []);
    } catch {
      // hiljainen epäonnistuminen, sivu toimii silti liittämisen osalta
    } finally {
      setLoadingCurrent(false);
    }
  }

  function handlePaste(text: string) {
    setRaw(text);
    const result = parsePlayersPaste(text);
    setPreview(result.players);
    setWarnings(result.warnings);
    setStatus(null);
  }

  async function handleSave() {
    if (preview.length === 0) return;
    setSaving(true);
    setStatus(null);
    localStorage.setItem("cron_secret", secret);
    try {
      const res = await fetch("/api/players/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ players: preview }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Virhe: ${data.error ?? "tuntematon virhe"}`);
      } else {
        setStatus(`Tallennettu: ${data.count} pelaajaa kirjoitettu tietokantaan.`);
        setRaw("");
        setPreview([]);
        await loadCurrent();
      }
    } catch (e: any) {
      setStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setSaving(false);
    }
  }

  function handleSitePaste(text: string) {
    setSiteRaw(text);
    const result = parseEpmSitePaste(text);
    setSitePreview(result.players);
    setSiteWarnings(result.warnings);
    setSiteStatus(null);
    setSiteRemove(new Set());
  }

  async function handleSiteSave() {
    if (sitePreview.length === 0) return;
    setSiteSaving(true);
    setSiteStatus(null);
    localStorage.setItem("cron_secret", secret);
    try {
      const existingForTeam = current.filter((p) => p.team === siteTeam);
      const posByName = new Map(existingForTeam.map((p) => [p.name, p.pos]));
      const activeByName = new Map(existingForTeam.map((p) => [p.name, p.active]));

      const players = sitePreview.map((p) => ({
        name: p.name,
        pos: posByName.get(p.name) ?? "",
        mpg_base: p.mpg,
        oepm: p.oepm,
        depm: p.depm,
        // Säilytetään aiempi active-tila jos pelaaja oli jo kannassa, muuten oletus true
        active: activeByName.has(p.name) ? activeByName.get(p.name) : true,
      }));

      const res = await fetch("/api/players/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ mode: "team", team: siteTeam, players, removeNames: siteMissing.filter((p) => siteRemove.has(p.name)).map((p) => p.name) }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSiteStatus(`Virhe: ${data.error ?? "tuntematon virhe"}`);
      } else {
        setSiteStatus(
          `Tallennettu: ${siteTeam} päivitetty, ${data.count} pelaajaa${data.removed ? `, ${data.removed} poistettu` : ""}.`
        );
        setSiteRaw("");
        setSitePreview([]);
        setSiteRemove(new Set());
        await loadCurrent();
      }
    } catch (e: any) {
      setSiteStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setSiteSaving(false);
    }
  }

  // Kannassa joukkueelle olevat pelaajat, joita EI ole liitteessä (esim. käsin
  // lisätyt tulokkaat tai joukkueesta lähteneet). Näitä ei poisteta, ellei
  // käyttäjä erikseen rastita niitä.
  const siteMissing = useMemo(() => {
    if (sitePreview.length === 0) return [];
    const names = new Set(sitePreview.map((p) => p.name));
    return current.filter((p) => p.team === siteTeam && !names.has(p.name));
  }, [sitePreview, current, siteTeam]);

  const manExisting = useMemo(
    () => current.find((p) => p.team === manTeam && p.name.trim().toLowerCase() === manName.trim().toLowerCase()) ?? null,
    [current, manTeam, manName]
  );

  async function handleManualSave() {
    if (!manName.trim()) return;
    setManSaving(true);
    setManStatus(null);
    localStorage.setItem("cron_secret", secret);
    try {
      if (!manExisting) {
        // Uusi pelaaja (esim. tulokas): luodaan ja kirjataan tulo joukkueen
        // lukuihin transaktiona, muuten hänen vaikutuksensa ei näy mallissa.
        const headers = { "Content-Type": "application/json", Authorization: `Bearer ${secret}` };
        const cr = await fetch("/api/players/create", {
          method: "POST",
          headers,
          body: JSON.stringify({ team: manTeam, name: manName.trim(), pos: manPos.trim(), oepm: manO, depm: manD, active: manActive }),
        });
        const cd = await cr.json().catch(() => ({}));
        if (!cr.ok || !cd.player?.id) {
          setManStatus(`Virhe: ${cd.error ?? cr.status}`);
          return;
        }
        const tr = await fetch("/api/transactions", {
          method: "POST",
          headers,
          body: JSON.stringify({ playerId: cd.player.id, newTeam: manTeam, newMpg: manActive ? manMpg : 0, arrival: true }),
        });
        const td = await tr.json().catch(() => ({}));
        if (!tr.ok) {
          setManStatus(`Pelaaja luotu, mutta tulon kirjaus epäonnistui: ${td.error ?? tr.status}`);
        } else {
          setManStatus(`Lisätty: ${manName.trim()} (${manTeam}), vaikutus kirjattu joukkueen lukuihin.`);
          setManName("");
          setManPos("");
        }
        await loadCurrent();
        return;
      }
      const res = await fetch("/api/players/import", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({
          mode: "merge",
          players: [
            {
              team: manTeam,
              name: manName.trim(),
              pos: manPos.trim(),
              mpg_base: manMpg,
              oepm: manO,
              depm: manD,
              active: manActive,
            },
          ],
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setManStatus(`Virhe: ${data.error ?? "tuntematon virhe"}`);
      } else {
        setManStatus(`${manExisting ? "Päivitetty" : "Lisätty"}: ${manName.trim()} (${manTeam}).`);
        setManName("");
        setManPos("");
        await loadCurrent();
      }
    } catch (e: any) {
      setManStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setManSaving(false);
    }
  }

  function handleLeaguePaste(text: string) {
    setLeagueRaw(text);
  }

  function handleLeagueAdd() {
    if (!leagueRaw.trim()) return;
    const result = parseEpmLeaguePaste(leagueRaw, TEAM_NAME_BY_ABBR);
    setLeagueWarnings(result.warnings);
    if (result.players.length === 0) return;

    setLeagueAcc((prev) => {
      const next = { ...prev };
      for (const p of result.players) {
        next[`${p.team}::${p.name}`] = p;
      }
      try {
        localStorage.setItem(LEAGUE_ACCUMULATOR_KEY, JSON.stringify(next));
      } catch {
        // localStorage voi olla täynnä tms., ei kaada sivua
      }
      return next;
    });
    setLeagueRaw("");
    setLeagueStatus(`Lisätty ${result.players.length} pelaajaa kasaan.`);
  }

  function handleLeagueClearAccumulator() {
    setLeagueAcc({});
    localStorage.removeItem(LEAGUE_ACCUMULATOR_KEY);
    setLeagueStatus(null);
  }

  async function handleLeagueSave() {
    const players = Object.values(leagueAcc);
    if (players.length === 0) return;
    setLeagueSaving(true);
    setLeagueStatus(null);
    localStorage.setItem("cron_secret", secret);
    try {
      const res = await fetch("/api/players/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({ mode: "merge", players }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLeagueStatus(`Virhe: ${data.error ?? "tuntematon virhe"}`);
      } else {
        setLeagueStatus(`Tallennettu: ${data.count} pelaajaa kirjoitettu/päivitetty tietokannassa.`);
        setLeagueAcc({});
        localStorage.removeItem(LEAGUE_ACCUMULATOR_KEY);
        await loadCurrent();
      }
    } catch (e: any) {
      setLeagueStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setLeagueSaving(false);
    }
  }

  const grouped = current.reduce<Record<string, DbPlayer[]>>((acc, p) => {
    (acc[p.team] ??= []).push(p);
    return acc;
  }, {});

  const teamsDone = useMemo(() => new Set(current.map((p) => p.team)), [current]);

  const leagueAccByTeam = useMemo(() => {
    const byTeam: Record<string, LeaguePlayer[]> = {};
    for (const p of Object.values(leagueAcc)) {
      (byTeam[p.team] ??= []).push(p);
    }
    return byTeam;
  }, [leagueAcc]);
  const leagueAccCount = Object.keys(leagueAcc).length;
  const leagueTeamsCovered = Object.keys(leagueAccByTeam).length;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 16 }}>Pelaajat — tuonti</h1>

      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid #334155" }}>
        <button
          onClick={() => setTab("excel")}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "transparent",
            border: "none",
            borderBottom: tab === "excel" ? "2px solid #2563eb" : "2px solid transparent",
            color: tab === "excel" ? "#e2e8f0" : "#64748b",
            cursor: "pointer",
          }}
        >
          Excel-tuonti (koko roster)
        </button>
        <button
          onClick={() => setTab("site")}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "transparent",
            border: "none",
            borderBottom: tab === "site" ? "2px solid #2563eb" : "2px solid transparent",
            color: tab === "site" ? "#e2e8f0" : "#64748b",
            cursor: "pointer",
          }}
        >
          EPM-sivun tuonti (1 joukkue)
        </button>
        <button
          onClick={() => setTab("league")}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "transparent",
            border: "none",
            borderBottom: tab === "league" ? "2px solid #2563eb" : "2px solid transparent",
            color: tab === "league" ? "#e2e8f0" : "#64748b",
            cursor: "pointer",
          }}
        >
          EPM koko liiga (kertyvä)
        </button>
        <button
          onClick={() => setTab("manual")}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "transparent",
            border: "none",
            borderBottom: tab === "manual" ? "2px solid #2563eb" : "2px solid transparent",
            color: tab === "manual" ? "#e2e8f0" : "#64748b",
            cursor: "pointer",
          }}
        >
          Lisää pelaaja (tulokkaat)
        </button>
        <button
          onClick={() => setTab("prev")}
          style={{
            padding: "8px 16px",
            fontSize: 13,
            background: "transparent",
            border: "none",
            borderBottom: tab === "prev" ? "2px solid #2563eb" : "2px solid transparent",
            color: tab === "prev" ? "#e2e8f0" : "#64748b",
            cursor: "pointer",
          }}
        >
          Alkutilanne
        </button>
      </div>

      {tab === "prev" && (() => {
        const off = computeRosterChange(current as any, prevRows);
        const teamsSorted = Object.values(off)
          .filter((t) => t.prevMin > 0 || t.roleMin > 0)
          .sort((x, y) => y.offO + y.offD - (x.offO + x.offD));
        const findNow = makePlayerFinder(current as any[]);
        const inputCss = { background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, fontSize: 12 };
        const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
        const cell = { padding: "2px 8px" };
        return (
          <div style={{ maxWidth: 980, marginBottom: 32 }}>
            <p style={{ color: "#64748b", fontSize: 13, marginBottom: 12, maxWidth: 820 }}>
              <strong>Alkutilanne</strong> = Excelisi rosterit ja minuutit. Se on se, mistä joukkueen 25-26 ORTG/DRTG koostuu, eikä
              se itsessään muuta lukuja: kun rosteri on alkutilanteessa, muutos on 0. <strong>Muutos</strong> = nykyinen rosteri −
              alkutilanne (EPM × minuutit / 48, molemmat skaalattu 240 minuuttiin). Vain Transactions-sivulla tekemäsi siirrot ja
              minuuttimuutokset liikuttavat lukuja. Alkutilanteen minuutteja voi muokata avaamalla joukkueen.
            </p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
              <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="CRON_SECRET (muokkaukseen)" style={{ ...inputCss, padding: "6px 8px", width: 200 }} />
              <span style={{ fontSize: 12, color: "#64748b" }}>
                Alkutilanteessa {prevRows.filter((r) => r.in_team).length} pelaajaa{prevLoaded ? "" : " (ladataan...)"}
              </span>
            </div>
            {prevStatus && (
              <div style={{ fontSize: 12, marginBottom: 10, color: prevStatus.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>{prevStatus}</div>
            )}
            {prevLoaded && prevRows.length === 0 ? (
              <div style={{ fontSize: 12, color: "#fbbf24" }}>
                Alkutilannetta ei ole vielä tallennettu. Aja supabase/setup_season_start.sql Supabasen SQL Editorissa.
              </div>
            ) : (
              <table style={{ borderCollapse: "collapse", fontSize: 12, marginBottom: 16 }}>
                <thead>
                  <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                    {["Joukkue", "Alkutilanne min", "Rosteri nyt min", "Muutos O", "D", "Net"].map((h) => (
                      <th key={h} style={{ padding: "4px 8px" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teamsSorted.map((t) => {
                    const net = t.offO + t.offD;
                    const startRows = prevRows.filter((r) => r.in_team && r.team === t.team).sort((a, b) => b.mpg - a.mpg);
                    const startNames = new Set(startRows.map((r) => normalizePlayerName(r.name)));
                    const newcomers = current.filter(
                      (c) => canonTeam(c.team) === t.team && c.active && c.mpg_base > 0 && !startRows.some((r) => findNow(r.name)?.id === c.id) && !startNames.has(normalizePlayerName(c.name))
                    );
                    return (
                      <Fragment key={t.team}>
                        <tr style={{ borderTop: "1px solid #1e293b" }}>
                          <td
                            style={{ padding: "4px 8px", cursor: "pointer", color: "#93c5fd" }}
                            onClick={() => setPrevOpenTeam((cur) => (cur === t.team ? null : t.team))}
                            title="Näytä alkutilanne ja nykyinen rosteri"
                          >
                            {prevOpenTeam === t.team ? "▾ " : "▸ "}
                            {t.team}
                          </td>
                          <td style={{ padding: "4px 8px", color: "#94a3b8" }}>{t.prevMin.toFixed(0)}</td>
                          <td style={{ padding: "4px 8px", color: "#94a3b8" }}>{t.roleMin.toFixed(0)}</td>
                          <td style={{ padding: "4px 8px" }}>{signed(t.offO)}</td>
                          <td style={{ padding: "4px 8px" }}>{signed(t.offD)}</td>
                          <td style={{ padding: "4px 8px", fontWeight: 700, color: Math.abs(net) < 0.005 ? "#94a3b8" : net >= 0 ? "#4ade80" : "#f87171" }}>{signed(net)}</td>
                        </tr>
                        {prevOpenTeam === t.team && (
                          <tr>
                            <td colSpan={6} style={{ padding: "4px 8px 10px 24px" }}>
                              <table style={{ borderCollapse: "collapse", fontSize: 11, color: "#94a3b8" }}>
                                <thead>
                                  <tr style={{ textAlign: "left" }}>
                                    {["Pelaaja", "EPM O / D", "Alkutilanne min", "Nyt"].map((h) => (
                                      <th key={h} style={cell}>
                                        {h}
                                      </th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {startRows.map((r) => {
                                    const now = findNow(r.name);
                                    const nowTeam = now ? canonTeam(now.team) : null;
                                    const nowStr = !now
                                      ? "ei kannassa"
                                      : nowTeam === t.team
                                      ? now.active
                                        ? `${now.mpg_base} min`
                                        : "ei aktiivinen"
                                      : `→ ${now.team}`;
                                    const changed = !now || nowTeam !== t.team || (now.active ? Number(now.mpg_base) : 0) !== Number(r.mpg);
                                    const o = now ? Number(now.oepm) : Number(r.oepm);
                                    const d = now ? Number(now.depm) : Number(r.depm);
                                    return (
                                      <tr key={r.id ?? r.name} style={{ borderTop: "1px solid #1e293b" }}>
                                        <td style={{ ...cell, color: "#e2e8f0" }}>{r.name}</td>
                                        <td style={cell}>
                                          {o.toFixed(1)} / {d.toFixed(1)}
                                        </td>
                                        <td style={cell}>
                                          <input
                                            value={startEdit[r.id!] ?? String(r.mpg)}
                                            onChange={(e) => setStartEdit((s) => ({ ...s, [r.id!]: e.target.value }))}
                                            onBlur={() => saveStartMinutes(r)}
                                            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
                                            disabled={!secret || !r.id}
                                            style={{ ...inputCss, width: 52, padding: "2px 4px" }}
                                          />
                                        </td>
                                        <td style={{ ...cell, color: changed ? "#fbbf24" : "#64748b" }}>{nowStr}</td>
                                      </tr>
                                    );
                                  })}
                                  {newcomers.map((c) => (
                                    <tr key={c.id} style={{ borderTop: "1px solid #1e293b" }}>
                                      <td style={{ ...cell, color: "#e2e8f0" }}>{c.name}</td>
                                      <td style={cell}>
                                        {Number(c.oepm).toFixed(1)} / {Number(c.depm).toFixed(1)}
                                      </td>
                                      <td style={cell}>—</td>
                                      <td style={{ ...cell, color: "#4ade80" }}>uusi · {c.mpg_base} min</td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            )}
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              Keltainen = poikkeaa alkutilanteesta (siirtynyt, minuutit muuttuneet tai ei aktiivinen). Net = O + D (pistettä / 100
              possessiota). Harmaa 0.00 = joukkue on alkutilanteessa.
            </div>
          </div>
        );
      })()}

      {tab === "manual" && (
        <div style={{ maxWidth: 520, marginBottom: 32 }}>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16 }}>
            Tulokkaille ja muille joita ei vielä ole EPM-sivulla. Anna arvioitu raaka-EPM (per 100
            poss, ei minuuttiskaalattu). Kun pelaaja myöhemmin ilmestyy EPM-sivulle, joukkueen
            päivitys korvaa arviot oikeilla luvuilla, kunhan nimi on kirjoitettu täsmälleen samoin.
          </p>

          <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Nimi</label>
          <input
            value={manName}
            onChange={(e) => setManName(e.target.value)}
            placeholder="Etunimi Sukunimi (kuten EPM-sivulla)"
            style={{ width: "100%", background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "8px 10px", fontSize: 13, marginBottom: 12 }}
          />

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            <div style={{ flex: 2 }}>
              <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Joukkue</label>
              <select
                value={manTeam}
                onChange={(e) => setManTeam(e.target.value)}
                style={{ width: "100%", background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}
              >
                <option value="Free Agent">Free Agent (ei joukkuetta)</option>
                {ALL_TEAMS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Pelipaikka</label>
              <input
                value={manPos}
                onChange={(e) => setManPos(e.target.value)}
                placeholder="esim. G, F, C"
                style={{ width: "100%", background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}
              />
            </div>
          </div>

          <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
            Pikavalinta (kokonais-EPM varausnumeron mukaan, karkea arvio)
          </label>
          <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
            {[
              { label: "Top-5 (−1.5)", o: -0.75, d: -0.75 },
              { label: "Lotto 6-14 (−2.5)", o: -1.5, d: -1.0 },
              { label: "Myöh. 1. kierros (−3.0)", o: -1.75, d: -1.25 },
              { label: "2. kierros (−3.5)", o: -2.0, d: -1.5 },
            ].map((preset) => (
              <button
                key={preset.label}
                onClick={() => {
                  setManO(preset.o);
                  setManD(preset.d);
                }}
                style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
              >
                {preset.label}
              </button>
            ))}
          </div>

          <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
            {[
              { label: "O-EPM", value: manO, set: setManO },
              { label: "D-EPM", value: manD, set: setManD },
              { label: "Minuutit (MPG)", value: manMpg, set: setManMpg },
            ].map((f) => (
              <div key={f.label} style={{ flex: 1 }}>
                <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>{f.label}</label>
                <input
                  type="number"
                  step="0.1"
                  value={f.value}
                  onChange={(e) => f.set(parseFloat(e.target.value) || 0)}
                  style={{ width: "100%", background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "8px 10px", fontSize: 13 }}
                />
              </div>
            ))}
          </div>

          <label style={{ fontSize: 12, color: "#94a3b8", display: "flex", alignItems: "center", gap: 6, marginBottom: 12 }}>
            <input type="checkbox" checked={manActive} onChange={(e) => setManActive(e.target.checked)} />
            Aktiivinen (mukana rotaatiossa)
          </label>

          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12 }}>
            Kokonais-EPM {(manO + manD).toFixed(1)} · vaikutus joukkueeseen minuuteilla {manMpg}:{" "}
            <strong style={{ color: (manO + manD) >= 0 ? "#4ade80" : "#f87171" }}>
              {(((manO + manD) * manMpg) / 48).toFixed(2)}
            </strong>
          </div>

          {manExisting && (
            <div style={{ fontSize: 12, color: "#fbbf24", marginBottom: 12 }}>
              {manExisting.name} on jo joukkueessa {manTeam} ({manExisting.oepm}/{manExisting.depm}, {manExisting.mpg_base} min) —
              tallennus päivittää hänen lukunsa.
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="CRON_SECRET"
              style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "6px 8px", fontSize: 12, width: 160 }}
            />
            <button
              onClick={handleManualSave}
              disabled={manSaving || !secret || !manName.trim()}
              style={{
                background: manSaving || !secret || !manName.trim() ? "#334155" : "#2563eb",
                color: "white",
                border: "none",
                borderRadius: 6,
                padding: "8px 16px",
                fontSize: 13,
                cursor: manSaving || !secret || !manName.trim() ? "not-allowed" : "pointer",
              }}
            >
              {manSaving ? "Tallennetaan..." : manExisting ? "Päivitä pelaaja" : "Lisää pelaaja"}
            </button>
          </div>
          {manStatus && (
            <div style={{ marginTop: 8, fontSize: 13, color: manStatus.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>
              {manStatus}
            </div>
          )}
        </div>
      )}

      {tab === "excel" && (
        <>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 24, maxWidth: 720 }}>
            Liitä Excelistä koko rosteri (otsikkorivi + datarivit, sarkaimella eroteltuna — kopioi
            suoraan Excelistä ja liitä tähän). Tämä <strong>korvaa koko nykyisen pelaajakannan</strong>{" "}
            tietokannassa, joten liitä aina koko lista, ei vain muuttuneita rivejä.
          </p>

          <div style={{ marginBottom: 8, fontSize: 12, color: "#94a3b8" }}>
            Odotetut sarakkeet (nimet joustavat): Joukkue, Pelaaja, Pos, Pelaajan EPM (O), Pelaajan
            EPM (D), Baseline Mins, Mins, Active
          </div>

          <textarea
            value={raw}
            onChange={(e) => handlePaste(e.target.value)}
            placeholder="Liitä Excel-data tähän (Ctrl+V)..."
            style={{
              width: "100%",
              maxWidth: 900,
              height: 160,
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: 8,
              fontFamily: "monospace",
              fontSize: 12,
            }}
          />

          {warnings.length > 0 && (
            <ul style={{ color: "#fbbf24", fontSize: 12, marginTop: 8 }}>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {preview.length > 0 && (
            <>
              <div style={{ marginTop: 16, marginBottom: 8, fontSize: 13 }}>
                Esikatselu: <strong>{preview.length}</strong> pelaajaa tunnistettu
              </div>
              <div style={{ maxHeight: 280, overflow: "auto", maxWidth: 900, border: "1px solid #334155", borderRadius: 6 }}>
                <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                  <thead style={{ position: "sticky", top: 0, background: "#1e293b" }}>
                    <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                      <th style={{ padding: 4 }}>Joukkue</th>
                      <th style={{ padding: 4 }}>Pelaaja</th>
                      <th style={{ padding: 4 }}>Pos</th>
                      <th style={{ padding: 4 }}>OEPM</th>
                      <th style={{ padding: 4 }}>DEPM</th>
                      <th style={{ padding: 4 }}>Mins</th>
                      <th style={{ padding: 4 }}>Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.map((p, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #1e293b" }}>
                        <td style={{ padding: 4 }}>{p.team}</td>
                        <td style={{ padding: 4 }}>{p.name}</td>
                        <td style={{ padding: 4 }}>{p.pos}</td>
                        <td style={{ padding: 4 }}>{p.oepm}</td>
                        <td style={{ padding: 4 }}>{p.depm}</td>
                        <td style={{ padding: 4 }}>{p.mpg_base}</td>
                        <td style={{ padding: 4 }}>{p.active ? "kyllä" : "ei"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="CRON_SECRET (sama kuin Vercelissä)"
                  style={{
                    background: "#1e293b",
                    color: "#e2e8f0",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    padding: "6px 8px",
                    fontSize: 12,
                    width: 260,
                  }}
                />
                <button
                  onClick={handleSave}
                  disabled={saving || !secret}
                  style={{
                    background: saving || !secret ? "#334155" : "#2563eb",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 16px",
                    fontSize: 13,
                    cursor: saving || !secret ? "not-allowed" : "pointer",
                  }}
                >
                  {saving ? "Tallennetaan..." : `Korvaa koko rosteri (${preview.length} pelaajaa)`}
                </button>
              </div>
              {status && (
                <div style={{ marginTop: 8, fontSize: 13, color: status.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>
                  {status}
                </div>
              )}
            </>
          )}
        </>
      )}

      {tab === "site" && (
        <>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16, maxWidth: 720 }}>
            Valitse joukkue, käy EPM-sivustolla sen pelaajasivulla, valitse koko taulukko ja
            kopioi (Ctrl+A / Ctrl+C taulukon sisällä, tai valitse hiirellä), liitä tähän. Tämä
            päivittää <strong>vain valitun joukkueen</strong> rivit — muut joukkueet säilyvät
            koskemattomina. MPG-luku otetaan talteen Baseline Mins -kenttään ja O-EPM/D-EPM
            päivittyvät suoraan.
          </p>

          <div style={{ marginBottom: 12 }}>
            <select
              value={siteTeam}
              onChange={(e) => setSiteTeam(e.target.value)}
              style={{
                background: "#1e293b",
                color: "#e2e8f0",
                border: "1px solid #334155",
                borderRadius: 6,
                padding: "6px 8px",
                fontSize: 13,
              }}
            >
              {ALL_TEAMS.map((t) => (
                <option key={t} value={t}>
                  {teamsDone.has(t) ? "✓ " : ""}
                  {t}
                </option>
              ))}
            </select>
            <span style={{ marginLeft: 12, fontSize: 12, color: "#64748b" }}>
              {teamsDone.size}/30 joukkuetta jo tietokannassa
            </span>
          </div>

          <textarea
            value={siteRaw}
            onChange={(e) => handleSitePaste(e.target.value)}
            placeholder="Liitä EPM-sivun taulukko tähän (Ctrl+V)..."
            style={{
              width: "100%",
              maxWidth: 900,
              height: 160,
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: 8,
              fontFamily: "monospace",
              fontSize: 12,
            }}
          />

          {siteWarnings.length > 0 && (
            <ul style={{ color: "#fbbf24", fontSize: 12, marginTop: 8 }}>
              {siteWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          {sitePreview.length > 0 && (
            <>
              <div style={{ marginTop: 16, marginBottom: 8, fontSize: 13 }}>
                Esikatselu: <strong>{sitePreview.length}</strong> pelaajaa tunnistettu joukkueelle{" "}
                <strong>{siteTeam}</strong>
              </div>
              <div style={{ maxHeight: 280, overflow: "auto", maxWidth: 900, border: "1px solid #334155", borderRadius: 6 }}>
                <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                  <thead style={{ position: "sticky", top: 0, background: "#1e293b" }}>
                    <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                      <th style={{ padding: 4 }}>Pelaaja</th>
                      <th style={{ padding: 4 }}>MPG</th>
                      <th style={{ padding: 4 }}>O-EPM</th>
                      <th style={{ padding: 4 }}>D-EPM</th>
                      <th style={{ padding: 4 }}>EPM yht.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sitePreview.map((p, i) => (
                      <tr key={i} style={{ borderTop: "1px solid #1e293b" }}>
                        <td style={{ padding: 4 }}>{p.name}</td>
                        <td style={{ padding: 4 }}>{p.mpg}</td>
                        <td style={{ padding: 4 }}>{p.oepm}</td>
                        <td style={{ padding: 4 }}>{p.depm}</td>
                        <td style={{ padding: 4, color: p.epmSumOk ? "#e2e8f0" : "#f87171" }}>{p.epmTotal}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {siteMissing.length > 0 && (
                <div style={{ marginTop: 16, maxWidth: 900, border: "1px solid #334155", borderRadius: 6, padding: 12 }}>
                  <div style={{ fontSize: 13, marginBottom: 4 }}>Kannassa, mutta ei liitteessä ({siteMissing.length}):</div>
                  <div style={{ fontSize: 11, color: "#64748b", marginBottom: 8 }}>
                    Nämä säilyvät oletuksena (esim. käsin lisätyt tulokkaat). Rastita vain ne, jotka oikeasti
                    ovat lähteneet joukkueesta, niin ne poistetaan.
                  </div>
                  {siteMissing.map((p) => (
                    <label key={p.id} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, padding: "2px 0" }}>
                      <input
                        type="checkbox"
                        checked={siteRemove.has(p.name)}
                        onChange={(e) =>
                          setSiteRemove((prev) => {
                            const next = new Set(prev);
                            if (e.target.checked) next.add(p.name);
                            else next.delete(p.name);
                            return next;
                          })
                        }
                      />
                      <span>
                        {p.name}{" "}
                        <span style={{ color: "#64748b" }}>
                          ({p.oepm}/{p.depm}, {p.mpg_base} min)
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}

              <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
                <input
                  type="password"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder="CRON_SECRET (sama kuin Vercelissä)"
                  style={{
                    background: "#1e293b",
                    color: "#e2e8f0",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    padding: "6px 8px",
                    fontSize: 12,
                    width: 260,
                  }}
                />
                <button
                  onClick={handleSiteSave}
                  disabled={siteSaving || !secret}
                  style={{
                    background: siteSaving || !secret ? "#334155" : "#2563eb",
                    color: "white",
                    border: "none",
                    borderRadius: 6,
                    padding: "8px 16px",
                    fontSize: 13,
                    cursor: siteSaving || !secret ? "not-allowed" : "pointer",
                  }}
                >
                  {siteSaving ? "Tallennetaan..." : `Päivitä ${siteTeam} (${sitePreview.length} pelaajaa)`}
                </button>
              </div>
              {siteStatus && (
                <div style={{ marginTop: 8, fontSize: 13, color: siteStatus.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>
                  {siteStatus}
                </div>
              )}
            </>
          )}
        </>
      )}

      {tab === "league" && (
        <>
          <p style={{ color: "#64748b", fontSize: 13, marginBottom: 16, maxWidth: 720 }}>
            EPM-sivustolla koko liigan lista näkyy yleensä usealla &quot;sivulla&quot; kun
            vierität. Liitä yksi pätkä kerrallaan alle ja paina &quot;Lisää kasaan&quot; — sovellus
            tunnistaa jokaisen pelaajan joukkueen lyhenteestä automaattisesti. Kun olet käynyt
            koko listan läpi (kaikki 30 joukkuetta näkyvissä alla), paina lopuksi
            &quot;Tallenna kaikki tietokantaan&quot;. Tämä <strong>ei poista</strong> ketään —
            se päivittää olemassaolevat pelaajat ja lisää uudet, muu roster säilyy.
          </p>
          <p style={{ color: "#fbbf24", fontSize: 12, marginBottom: 16, maxWidth: 720 }}>
            Vaatii kertaalleen ajetun SQL:n Supabasessa:{" "}
            <code>supabase/add_players_unique_constraint.sql</code>
          </p>

          <textarea
            value={leagueRaw}
            onChange={(e) => handleLeaguePaste(e.target.value)}
            placeholder="Liitä EPM-sivun koko liigan pätkä tähän (Ctrl+V)..."
            style={{
              width: "100%",
              maxWidth: 900,
              height: 160,
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: 8,
              fontFamily: "monospace",
              fontSize: 12,
            }}
          />

          <div style={{ marginTop: 8 }}>
            <button
              onClick={handleLeagueAdd}
              disabled={!leagueRaw.trim()}
              style={{
                background: !leagueRaw.trim() ? "#334155" : "#334155",
                color: "#e2e8f0",
                border: "1px solid #475569",
                borderRadius: 6,
                padding: "6px 14px",
                fontSize: 13,
                cursor: !leagueRaw.trim() ? "not-allowed" : "pointer",
              }}
            >
              Lisää kasaan
            </button>
          </div>

          {leagueWarnings.length > 0 && (
            <ul style={{ color: "#fbbf24", fontSize: 12, marginTop: 8 }}>
              {leagueWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}

          <div style={{ marginTop: 20, marginBottom: 8, fontSize: 13 }}>
            Kasassa nyt: <strong>{leagueAccCount}</strong> pelaajaa, <strong>{leagueTeamsCovered}</strong>/30
            joukkuetta edustettuna
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 6, maxWidth: 1100, marginBottom: 16 }}>
            {ALL_TEAMS.map((t) => {
              const count = leagueAccByTeam[t]?.length ?? 0;
              return (
                <div
                  key={t}
                  style={{
                    fontSize: 11,
                    padding: "4px 8px",
                    borderRadius: 4,
                    background: count > 0 ? "#14532d" : "#1e293b",
                    color: count > 0 ? "#4ade80" : "#64748b",
                  }}
                >
                  {t}: {count}
                </div>
              );
            })}
          </div>

          {leagueAccCount > 0 && (
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <input
                type="password"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                placeholder="CRON_SECRET (sama kuin Vercelissä)"
                style={{
                  background: "#1e293b",
                  color: "#e2e8f0",
                  border: "1px solid #334155",
                  borderRadius: 6,
                  padding: "6px 8px",
                  fontSize: 12,
                  width: 260,
                }}
              />
              <button
                onClick={handleLeagueSave}
                disabled={leagueSaving || !secret}
                style={{
                  background: leagueSaving || !secret ? "#334155" : "#2563eb",
                  color: "white",
                  border: "none",
                  borderRadius: 6,
                  padding: "8px 16px",
                  fontSize: 13,
                  cursor: leagueSaving || !secret ? "not-allowed" : "pointer",
                }}
              >
                {leagueSaving ? "Tallennetaan..." : `Tallenna kaikki tietokantaan (${leagueAccCount})`}
              </button>
              <button
                onClick={handleLeagueClearAccumulator}
                style={{
                  background: "transparent",
                  color: "#f87171",
                  border: "1px solid #7f1d1d",
                  borderRadius: 6,
                  padding: "8px 16px",
                  fontSize: 13,
                  cursor: "pointer",
                }}
              >
                Tyhjennä kasa
              </button>
            </div>
          )}
          {leagueStatus && (
            <div style={{ marginTop: 8, fontSize: 13, color: leagueStatus.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>
              {leagueStatus}
            </div>
          )}
        </>
      )}

      <div style={{ marginTop: 40, marginBottom: 8, display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 16, margin: 0 }}>Nykyinen tietokannan rosteri ({current.length} pelaajaa)</h2>
        <span style={{ fontSize: 12, color: "#64748b" }}>
          Kuva löytyy {current.filter((p: any) => p.headshot_url || p.nba_id).length}/{current.length} pelaajalle
        </span>
        <button
          onClick={handleSyncIds}
          disabled={syncing || !secret}
          title="Hakee NBA:n pelaajahakemistosta jokaiselle pelaajalle tunnisteen, jolla kuvat haetaan Matchup-sivulle"
          style={{
            background: syncing || !secret ? "#334155" : "#2563eb",
            color: "white",
            border: "none",
            borderRadius: 6,
            padding: "6px 12px",
            fontSize: 12,
            cursor: syncing || !secret ? "not-allowed" : "pointer",
          }}
        >
          {syncing ? "Haetaan..." : "Hae pelaajakuvat"}
        </button>
        {syncStatus && (
          <span style={{ fontSize: 12, color: syncStatus.startsWith("Virhe") ? "#f87171" : "#4ade80", maxWidth: 700 }}>
            {syncStatus}
          </span>
        )}
      </div>
      {loadingCurrent ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ladataan...</div>
      ) : current.length === 0 ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ei vielä pelaajia tietokannassa.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 12, maxWidth: 1100 }}>
          {Object.entries(grouped)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([team, players]) => (
              <div key={team} style={{ border: "1px solid #334155", borderRadius: 6, padding: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 4 }}>{team}</div>
                {players
                  .sort((a, b) => (b.oepm + b.depm) - (a.oepm + a.depm))
                  .map((p) => {
                    const total = p.oepm + p.depm;
                    return (
                      <div key={p.id} style={{ fontSize: 11, color: p.active ? "#e2e8f0" : "#64748b", display: "flex", justifyContent: "space-between", gap: 8 }}>
                        <span>{p.name}</span>
                        <span style={{ color: "#94a3b8", whiteSpace: "nowrap" }}>
                          {p.oepm}/{p.depm} ={" "}
                          <strong style={{ color: total >= 0 ? "#4ade80" : "#f87171" }}>
                            {total > 0 ? "+" : ""}
                            {total.toFixed(1)}
                          </strong>
                        </span>
                      </div>
                    );
                  })}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}
