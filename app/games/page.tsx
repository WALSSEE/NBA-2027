"use client";

import { useEffect, useMemo, useState } from "react";

type Game = {
  id: string;
  game_id: string | null;
  date: string;
  home: string;
  away: string;
  home_score: number | null;
  away_score: number | null;
  home_ortg: number | null;
  home_drtg: number | null;
  home_pace: number | null;
  away_ortg: number | null;
  away_drtg: number | null;
  away_pace: number | null;
};

export default function GamesPage() {
  const [games, setGames] = useState<Game[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"upcoming" | "played">("upcoming");

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/schedule");
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setGames(data.games ?? []);
      } catch (e: any) {
        setError(e.message ?? "Virhe datan haussa");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const upcoming = useMemo(() => games.filter((g) => g.home_score == null).sort((a, b) => a.date.localeCompare(b.date)), [games]);
  const played = useMemo(
    () => games.filter((g) => g.home_score != null).sort((a, b) => b.date.localeCompare(a.date)),
    [games]
  );

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Games — otteluohjelma</h1>
      <p style={{ color: "#64748b", fontSize: 13, margin: "8px 0 20px", maxWidth: 720 }}>
        Data haetaan automaattisesti cron-tehtävillä. Pelatut ottelut (joilla on ORTG/DRTG/Pace)
        syöttävät Matchup-laskurin EWMA-päivitykseen.
      </p>

      {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 16 }}>Virhe: {error}</div>}

      <div style={{ display: "flex", gap: 4, marginBottom: 16 }}>
        <button
          onClick={() => setTab("upcoming")}
          style={{
            padding: "6px 14px",
            fontSize: 13,
            borderRadius: 6,
            border: "1px solid #334155",
            background: tab === "upcoming" ? "#1e293b" : "transparent",
            color: "#e2e8f0",
            cursor: "pointer",
          }}
        >
          Tulevat ({upcoming.length})
        </button>
        <button
          onClick={() => setTab("played")}
          style={{
            padding: "6px 14px",
            fontSize: 13,
            borderRadius: 6,
            border: "1px solid #334155",
            background: tab === "played" ? "#1e293b" : "transparent",
            color: "#e2e8f0",
            cursor: "pointer",
          }}
        >
          Pelatut ({played.length})
        </button>
      </div>

      {loading ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ladataan...</div>
      ) : (
        <table style={{ borderCollapse: "collapse", fontSize: 12, maxWidth: 900 }}>
          <thead>
            <tr style={{ color: "#94a3b8", textAlign: "left" }}>
              <th style={{ padding: 6 }}>Pvm</th>
              <th style={{ padding: 6 }}>Koti</th>
              <th style={{ padding: 6 }}>Vieras</th>
              {tab === "played" && (
                <>
                  <th style={{ padding: 6 }}>Tulos</th>
                  <th style={{ padding: 6 }}>Koti ORTG/DRTG/Pace</th>
                  <th style={{ padding: 6 }}>Vieras ORTG/DRTG/Pace</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {(tab === "upcoming" ? upcoming : played).map((g) => (
              <tr key={g.id} style={{ borderTop: "1px solid #1e293b" }}>
                <td style={{ padding: 6 }}>{g.date}</td>
                <td style={{ padding: 6 }}>{g.home}</td>
                <td style={{ padding: 6 }}>{g.away}</td>
                {tab === "played" && (
                  <>
                    <td style={{ padding: 6 }}>
                      {g.home_score}–{g.away_score}
                    </td>
                    <td style={{ padding: 6 }}>
                      {g.home_ortg ?? "—"} / {g.home_drtg ?? "—"} / {g.home_pace ?? "—"}
                    </td>
                    <td style={{ padding: 6 }}>
                      {g.away_ortg ?? "—"} / {g.away_drtg ?? "—"} / {g.away_pace ?? "—"}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {(tab === "upcoming" ? upcoming : played).length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: 6, color: "#64748b" }}>
                  Ei otteluita tässä kategoriassa.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
