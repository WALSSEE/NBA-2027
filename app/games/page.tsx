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
  const [tab, setTab] = useState<"upcoming" | "played" | "pre">("upcoming");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    setSecret(localStorage.getItem("cron_secret") ?? "");
  }, []);
  async function runJob(kind: "schedule" | "results") {
    setBusy(kind);
    setMsg(null);
    localStorage.setItem("cron_secret", secret);
    try {
      const res = await fetch(kind === "schedule" ? "/api/cron/update-schedule" : "/api/cron/update-nba-data", {
        headers: { Authorization: `Bearer ${secret}` },
      });
      const j = await res.json().catch(() => ({ error: `palvelin vastasi ${res.status}` }));
      if (!res.ok || j.ok === false) setMsg(`Virhe: ${j.error ?? res.status}`);
      else if (kind === "schedule") setMsg(`Otteluohjelma haettu (${j.source}): runkosarja ${j.regular ?? j.total}, harjoituskausi ${j.preseason ?? 0} ottelua, ${j.inserted} tallennettu, ${j.deletedBefore ?? "?"} vanhaa poistettu ennen hakua${j.removedDuplicates ? `, ${j.removedDuplicates} tuplaa/vanhentunutta poistettu` : ""}.${j.notes?.length ? " " + j.notes.join(" · ") : ""}`);
      else setMsg(`Tulokset päivitetty: ${j.updated} ottelua.${j.remainingDays ? ` Päiviä vielä jäljellä ${j.remainingDays} — paina uudelleen.` : ""}`);
      const data = await fetch("/api/schedule", { cache: "no-store" }).then((r) => r.json());
      setGames(data.games ?? []);
    } catch (e: any) {
      setMsg(`Virhe: ${e?.message ?? e}`);
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch("/api/schedule", { cache: "no-store" });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        setGames(data.games ?? []);
        if (data.duplicatesHidden) setMsg(`Huom: tietokannassa ${data.rawRows} riviä, joista ${data.duplicatesHidden} tuplaa piilotettu.`);
      } catch (e: any) {
        setError(e.message ?? "Virhe datan haussa");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const isPre = (g: Game) => (g as any).season_type === "pre";
  const upcoming = useMemo(() => games.filter((g) => !isPre(g) && g.home_score == null).sort((a, b) => a.date.localeCompare(b.date)), [games]);
  const played = useMemo(
    () => games.filter((g) => !isPre(g) && g.home_score != null).sort((a, b) => b.date.localeCompare(a.date)),
    [games]
  );
  const preseason = useMemo(() => games.filter((g) => isPre(g)).sort((a, b) => a.date.localeCompare(b.date)), [games]);
  const listed = tab === "upcoming" ? upcoming : tab === "played" ? played : preseason;

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Games — otteluohjelma</h1>
      <p style={{ color: "#64748b", fontSize: 13, margin: "8px 0 20px", maxWidth: 720 }}>
        Otteluohjelma ja tulokset haetaan automaattisesti (ohjelma maanantaisin, tulokset päivittäin) NBA:n CDN:stä / ESPN:stä.
        Pelatut ottelut (ORTG/DRTG/Pace) syöttävät Matchupin EWMA-päivitykseen ja Kausi-simulaatioon. Napeilla voit ajaa haun heti.
      </p>

      {error && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 16 }}>Virhe: {error}</div>}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 16 }}>
        <input
          type="password"
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          placeholder="CRON_SECRET"
          style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "6px 8px", fontSize: 12, width: 150 }}
        />
        <button onClick={() => runJob("schedule")} disabled={!!busy || !secret} style={{ background: "#2563eb", color: "white", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12, cursor: "pointer" }}>
          {busy === "schedule" ? "Haetaan..." : "Hae kauden otteluohjelma"}
        </button>
        <button onClick={() => runJob("results")} disabled={!!busy || !secret} style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "7px 12px", fontSize: 12, cursor: "pointer" }}>
          {busy === "results" ? "Päivitetään..." : "Päivitä pelattujen tulokset"}
        </button>
        {msg && <span style={{ fontSize: 12, color: msg.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>{msg}</span>}
      </div>

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
        <button
          onClick={() => setTab("pre")}
          style={{
            padding: "6px 14px",
            fontSize: 13,
            borderRadius: 6,
            border: "1px solid #334155",
            background: tab === "pre" ? "#1e293b" : "transparent",
            color: "#e2e8f0",
            cursor: "pointer",
          }}
        >
          Harjoituskausi ({preseason.length})
        </button>
      </div>

      {tab === "pre" && (
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 10, maxWidth: 820, lineHeight: 1.6 }}>
          Harjoituspelit eivät vaikuta malliin (EWMA, väsymys, kausisimulaatio). Vedonlyöntiin: valitse ottelu Matchupissa ja paina
          joukkuepaneelin <strong>Harjoituspeli</strong>-nappia — se rajaa tähtien minuutit ja jakaa loput penkille. Säädä minuutit
          sen jälkeen tietojesi mukaan (kuka lepää, kuka pelaa).
        </div>
      )}
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
            {listed.map((g) => (
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
            {listed.length === 0 && (
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
