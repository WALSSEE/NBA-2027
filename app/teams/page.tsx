"use client";

import { useEffect, useMemo, useState } from "react";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";

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
};

type NumField = "ortg_2425" | "drtg_2425" | "pace_2425" | "ortg_2526" | "drtg_2526" | "pace_2526" | "home_adv" | "win_total";
type SortKey = "team" | "net_2425" | "net_2526" | "net_change" | NumField;

const ALL_TEAMS = Array.from(new Set(Object.values(TEAM_NAME_BY_ABBR))).sort();

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

export default function TeamsPage() {
  const [secret, setSecret] = useState("");
  const [rows, setRows] = useState<Record<string, TeamStats>>({});
  // Tallennetut arvot — järjestys lasketaan näistä, jotta rivi ei hypi
  // kesken kirjoittamisen.
  const [saved, setSaved] = useState<Record<string, TeamStats>>({});
  const [loading, setLoading] = useState(true);
  const [savingTeam, setSavingTeam] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("net_2526");
  const [sortDesc, setSortDesc] = useState(true);

  useEffect(() => {
    setSecret(localStorage.getItem("cron_secret") ?? "");
    load();
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
      setSortDesc(key !== "team" && !key.startsWith("drtg"));
    }
  }

  // Järjestys lasketaan tallennetuista arvoista; tyhjät aina viimeiseksi.
  const sortedTeams = useMemo(() => {
    const list = ALL_TEAMS.map((t) => saved[t] ?? emptyRow(t));
    return list.sort((a, b) => {
      const va = sortValue(a, sortKey);
      const vb = sortValue(b, sortKey);
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : (va as number) - (vb as number);
      return sortDesc ? -cmp : cmp;
    });
  }, [saved, sortKey, sortDesc]);

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

  const groupHead = { padding: "4px", fontSize: 11, color: "#64748b", textAlign: "center" as const, borderBottom: "1px solid #1e293b" };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Teams</h1>
      <p style={{ color: "#64748b", fontSize: 13, margin: "8px 0 20px", maxWidth: 760 }}>
        Matchup-laskurin pohjaluvut: molempien kausien ORTG/DRTG/Pace, &quot;Coach vaihtui&quot;-lippu (käyttää
        vain 25-26 dataa) ja kotietu (HCA, pistettä). Net Rating = ORTG − DRTG lasketaan automaattisesti. Klikkaa
        sarakkeen otsikkoa järjestääksesi. Tallenna muutokset rivi kerrallaan.
      </p>

      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontSize: 12, color: "#94a3b8" }}>CRON_SECRET</label>
        <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ ...inputStyle, width: 160 }} />
        {status && (
          <span style={{ fontSize: 12, color: status.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>{status}</span>
        )}
      </div>

      {loading ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ladataan...</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <thead>
              <tr>
                <th />
                <th />
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
                <SortHeader k="win_total" label="Win total" title="Markkinan runkosarjan voittoraja 26-27 (Matchup vertaa malliin)" />
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
