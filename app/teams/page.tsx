"use client";

import { useEffect, useState } from "react";
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
};

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
  };
}

export default function TeamsPage() {
  const [secret, setSecret] = useState("");
  const [rows, setRows] = useState<Record<string, TeamStats>>({});
  const [loading, setLoading] = useState(true);
  const [savingTeam, setSavingTeam] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

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
      }
    } catch (e: any) {
      setStatus(`Virhe (${team}): ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setSavingTeam(null);
    }
  }

  const inputStyle = {
    width: 64,
    background: "#1e293b",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 4,
    padding: "4px 6px",
    fontSize: 12,
  };

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Teams — kausiblendauksen pohjaluvut</h1>
      <p style={{ color: "#64748b", fontSize: 13, margin: "8px 0 20px", maxWidth: 760 }}>
        Nämä ovat Matchup-laskurin käyttämä preseason-prior: molempien kausien ORTG/DRTG/Pace,
        &quot;Coach vaihtui&quot;-lippu (ohittaa kausiblendauksen ja käyttää vain 25-26 dataa) ja
        kotietu (HCA, pistettä). Tallenna rivi kerrallaan.
      </p>

      <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 8 }}>
        <label style={{ fontSize: 12, color: "#94a3b8" }}>CRON_SECRET</label>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          style={{ ...inputStyle, width: 160 }}
        />
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
              <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                <th style={{ padding: 4 }}>Joukkue</th>
                <th style={{ padding: 4 }} colSpan={3}>
                  23-24 kausi (ORTG / DRTG / Pace)
                </th>
                <th style={{ padding: 4 }} colSpan={3}>
                  25-26 kausi (ORTG / DRTG / Pace)
                </th>
                <th style={{ padding: 4 }}>Coach vaihtui</th>
                <th style={{ padding: 4 }}>HCA</th>
                <th style={{ padding: 4 }}></th>
              </tr>
            </thead>
            <tbody>
              {ALL_TEAMS.map((team) => {
                const row = rows[team] ?? emptyRow(team);
                return (
                  <tr key={team} style={{ borderTop: "1px solid #1e293b" }}>
                    <td style={{ padding: 4, whiteSpace: "nowrap" }}>{team}</td>
                    <td style={{ padding: 2 }}>
                      <input
                        type="number"
                        value={row.ortg_2425 ?? ""}
                        onChange={(e) => updateField(team, "ortg_2425", e.target.value === "" ? null : Number(e.target.value))}
                        style={inputStyle}
                      />
                    </td>
                    <td style={{ padding: 2 }}>
                      <input
                        type="number"
                        value={row.drtg_2425 ?? ""}
                        onChange={(e) => updateField(team, "drtg_2425", e.target.value === "" ? null : Number(e.target.value))}
                        style={inputStyle}
                      />
                    </td>
                    <td style={{ padding: 2 }}>
                      <input
                        type="number"
                        value={row.pace_2425 ?? ""}
                        onChange={(e) => updateField(team, "pace_2425", e.target.value === "" ? null : Number(e.target.value))}
                        style={inputStyle}
                      />
                    </td>
                    <td style={{ padding: 2 }}>
                      <input
                        type="number"
                        value={row.ortg_2526 ?? ""}
                        onChange={(e) => updateField(team, "ortg_2526", e.target.value === "" ? null : Number(e.target.value))}
                        style={inputStyle}
                      />
                    </td>
                    <td style={{ padding: 2 }}>
                      <input
                        type="number"
                        value={row.drtg_2526 ?? ""}
                        onChange={(e) => updateField(team, "drtg_2526", e.target.value === "" ? null : Number(e.target.value))}
                        style={inputStyle}
                      />
                    </td>
                    <td style={{ padding: 2 }}>
                      <input
                        type="number"
                        value={row.pace_2526 ?? ""}
                        onChange={(e) => updateField(team, "pace_2526", e.target.value === "" ? null : Number(e.target.value))}
                        style={inputStyle}
                      />
                    </td>
                    <td style={{ padding: 4, textAlign: "center" }}>
                      <input
                        type="checkbox"
                        checked={!!row.coach_change}
                        onChange={(e) => updateField(team, "coach_change", e.target.checked)}
                      />
                    </td>
                    <td style={{ padding: 2 }}>
                      <input
                        type="number"
                        value={row.home_adv ?? ""}
                        onChange={(e) => updateField(team, "home_adv", e.target.value === "" ? null : Number(e.target.value))}
                        style={inputStyle}
                      />
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
