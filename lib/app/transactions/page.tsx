"use client";

import { useEffect, useMemo, useState } from "react";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";

type DbPlayer = {
  id: string;
  team: string;
  name: string;
  pos: string;
  mpg_base: number;
  oepm: number;
  depm: number;
  active: boolean;
};

type Transaction = {
  id: string;
  date: string;
  player_name: string;
  team: string;
  direction: "in" | "out";
  delta_o: number;
  delta_d: number;
  created_at: string;
};

const ALL_TEAMS = Array.from(new Set(Object.values(TEAM_NAME_BY_ABBR))).sort();

export default function TransactionsPage() {
  const [secret, setSecret] = useState("");
  const [players, setPlayers] = useState<DbPlayer[]>([]);
  const [loadingPlayers, setLoadingPlayers] = useState(true);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loadingTx, setLoadingTx] = useState(true);

  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState(ALL_TEAMS[0] ?? "");
  const [newMpg, setNewMpg] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    setSecret(localStorage.getItem("cron_secret") ?? "");
    loadPlayers();
    loadTransactions();
  }, []);

  async function loadPlayers() {
    setLoadingPlayers(true);
    try {
      const res = await fetch("/api/players/import");
      const data = await res.json();
      setPlayers(data.players ?? []);
    } catch {
      // ei haittaa
    } finally {
      setLoadingPlayers(false);
    }
  }

  async function loadTransactions() {
    setLoadingTx(true);
    try {
      const res = await fetch("/api/transactions");
      const data = await res.json();
      setTransactions(data.transactions ?? []);
    } catch {
      // ei haittaa
    } finally {
      setLoadingTx(false);
    }
  }

  const filteredPlayers = useMemo(() => {
    if (!search.trim()) return [];
    const q = search.toLowerCase();
    return players.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 20);
  }, [players, search]);

  const selected = useMemo(() => players.find((p) => p.id === selectedId) ?? null, [players, selectedId]);

  function selectPlayer(p: DbPlayer) {
    setSelectedId(p.id);
    setSearch(p.name);
    setNewTeam(p.team);
    setNewMpg(p.mpg_base);
    setStatus(null);
  }

  const preview = useMemo(() => {
    if (!selected) return null;
    const oldMpg = selected.mpg_base;
    const deltaOutO = -selected.oepm * (oldMpg / 48);
    const deltaOutD = -selected.depm * (oldMpg / 48);
    const deltaInO = selected.oepm * (newMpg / 48);
    const deltaInD = selected.depm * (newMpg / 48);
    return { deltaOutO, deltaOutD, deltaInO, deltaInD };
  }, [selected, newMpg]);

  async function handleSubmit() {
    if (!selected) return;
    setSaving(true);
    setStatus(null);
    localStorage.setItem("cron_secret", secret);
    try {
      const res = await fetch("/api/transactions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ playerId: selected.id, newTeam, newMpg }),
      });
      const data = await res.json();
      if (!res.ok) {
        setStatus(`Virhe: ${data.error ?? "tuntematon virhe"}`);
      } else {
        setStatus(
          `Kirjattu: ${selected.name} ${data.oldTeam} → ${data.newTeam}. ${data.oldTeam}: ${data.deltaOut.o.toFixed(
            2
          )}/${data.deltaOut.d.toFixed(2)}, ${data.newTeam}: +${data.deltaIn.o.toFixed(2)}/+${data.deltaIn.d.toFixed(2)}`
        );
        setSelectedId(null);
        setSearch("");
        await Promise.all([loadPlayers(), loadTransactions()]);
      }
    } catch (e: any) {
      setStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setSaving(false);
    }
  }

  const teamNetImpact = useMemo(() => {
    const byTeam: Record<string, { o: number; d: number }> = {};
    for (const t of transactions) {
      const entry = (byTeam[t.team] ??= { o: 0, d: 0 });
      entry.o += Number(t.delta_o) || 0;
      entry.d += Number(t.delta_d) || 0;
    }
    return byTeam;
  }, [transactions]);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Transaktiot — treidit ja minuuttimuutokset</h1>
      <p style={{ color: "#64748b", fontSize: 13, marginBottom: 24, maxWidth: 720 }}>
        Kun pelaaja siirtyy joukkueesta toiseen (tai hänen odotetut minuuttinsa muuttuvat), kirjaa
        se tähän. Vaikutus lasketaan automaattisesti: <code>raaka EPM × (minuutit / 48)</code> —
        lähtevä joukkue saa negatiivisen, vastaanottava positiivisen deltan. Pelaajan joukkue ja
        minuutit päivittyvät samalla Pelaajat-sivulle.
      </p>

      <div style={{ maxWidth: 480, marginBottom: 24 }}>
        <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Etsi pelaaja</label>
        <input
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setSelectedId(null);
          }}
          placeholder="Kirjoita pelaajan nimi..."
          style={{
            width: "100%",
            background: "#1e293b",
            color: "#e2e8f0",
            border: "1px solid #334155",
            borderRadius: 6,
            padding: "8px 10px",
            fontSize: 13,
          }}
        />
        {!selected && filteredPlayers.length > 0 && (
          <div style={{ border: "1px solid #334155", borderRadius: 6, marginTop: 4, maxHeight: 200, overflow: "auto" }}>
            {filteredPlayers.map((p) => (
              <div
                key={p.id}
                onClick={() => selectPlayer(p)}
                style={{
                  padding: "6px 10px",
                  fontSize: 13,
                  cursor: "pointer",
                  borderBottom: "1px solid #1e293b",
                  display: "flex",
                  justifyContent: "space-between",
                }}
              >
                <span>{p.name}</span>
                <span style={{ color: "#64748b" }}>{p.team}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {selected && (
        <div style={{ maxWidth: 480, marginBottom: 24, border: "1px solid #334155", borderRadius: 8, padding: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>{selected.name}</div>
          <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
            Nykyinen joukkue: {selected.team} · raaka EPM O/D: {selected.oepm}/{selected.depm} · nyk. minuutit:{" "}
            {selected.mpg_base}
          </div>

          <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Uusi joukkue</label>
          <select
            value={newTeam}
            onChange={(e) => setNewTeam(e.target.value)}
            style={{
              width: "100%",
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 13,
              marginBottom: 12,
            }}
          >
            {ALL_TEAMS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>

          <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
            Odotetut minuutit uudessa joukkueessa
          </label>
          <input
            type="number"
            value={newMpg}
            onChange={(e) => setNewMpg(parseFloat(e.target.value) || 0)}
            style={{
              width: "100%",
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "8px 10px",
              fontSize: 13,
              marginBottom: 12,
            }}
          />

          {preview && (
            <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12, lineHeight: 1.6 }}>
              <div>
                {selected.team} (lähtevä): O {preview.deltaOutO.toFixed(2)}, D {preview.deltaOutD.toFixed(2)}
              </div>
              <div>
                {newTeam} (vastaanottava): O +{preview.deltaInO.toFixed(2)}, D +{preview.deltaInD.toFixed(2)}
              </div>
            </div>
          )}

          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <input
              type="password"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder="CRON_SECRET"
              style={{
                background: "#1e293b",
                color: "#e2e8f0",
                border: "1px solid #334155",
                borderRadius: 6,
                padding: "6px 8px",
                fontSize: 12,
                width: 160,
              }}
            />
            <button
              onClick={handleSubmit}
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
              {saving ? "Kirjataan..." : "Kirjaa transaktio"}
            </button>
          </div>
          {status && (
            <div style={{ marginTop: 8, fontSize: 12, color: status.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>
              {status}
            </div>
          )}
        </div>
      )}

      <h2 style={{ fontSize: 16, marginTop: 32, marginBottom: 8 }}>Joukkueiden nettovaikutus transaktioista</h2>
      {loadingTx ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ladataan...</div>
      ) : Object.keys(teamNetImpact).length === 0 ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ei vielä kirjattuja transaktioita.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8, maxWidth: 1000, marginBottom: 32 }}>
          {Object.entries(teamNetImpact)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([team, delta]) => (
              <div key={team} style={{ fontSize: 12, border: "1px solid #334155", borderRadius: 6, padding: "6px 10px" }}>
                <div style={{ fontWeight: 600, marginBottom: 2 }}>{team}</div>
                <div style={{ color: "#94a3b8" }}>
                  ORTG {delta.o >= 0 ? "+" : ""}
                  {delta.o.toFixed(2)} / DRTG {delta.d >= 0 ? "+" : ""}
                  {delta.d.toFixed(2)}
                </div>
              </div>
            ))}
        </div>
      )}

      <h2 style={{ fontSize: 16, marginBottom: 8 }}>Transaktioloki</h2>
      {loadingPlayers || loadingTx ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ladataan...</div>
      ) : transactions.length === 0 ? (
        <div style={{ color: "#64748b", fontSize: 13 }}>Ei vielä transaktioita.</div>
      ) : (
        <div style={{ maxHeight: 400, overflow: "auto", maxWidth: 900, border: "1px solid #334155", borderRadius: 6 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <thead style={{ position: "sticky", top: 0, background: "#1e293b" }}>
              <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                <th style={{ padding: 4 }}>Pvm</th>
                <th style={{ padding: 4 }}>Pelaaja</th>
                <th style={{ padding: 4 }}>Joukkue</th>
                <th style={{ padding: 4 }}>Suunta</th>
                <th style={{ padding: 4 }}>Δ O</th>
                <th style={{ padding: 4 }}>Δ D</th>
              </tr>
            </thead>
            <tbody>
              {transactions.map((t) => (
                <tr key={t.id} style={{ borderTop: "1px solid #1e293b" }}>
                  <td style={{ padding: 4 }}>{t.date}</td>
                  <td style={{ padding: 4 }}>{t.player_name}</td>
                  <td style={{ padding: 4 }}>{t.team}</td>
                  <td style={{ padding: 4, color: t.direction === "in" ? "#4ade80" : "#f87171" }}>{t.direction}</td>
                  <td style={{ padding: 4 }}>{Number(t.delta_o).toFixed(2)}</td>
                  <td style={{ padding: 4 }}>{Number(t.delta_d).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
