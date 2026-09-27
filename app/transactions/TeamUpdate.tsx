"use client";

import { useMemo, useState } from "react";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";
import { parseTeamTransactions, normalizePlayerName, type ParsedMove } from "@/lib/parseTransactions";

export type DbPlayer = {
  id: string;
  team: string;
  name: string;
  pos: string;
  mpg_base: number;
  oepm: number;
  depm: number;
  active: boolean;
};

export const FREE_AGENT = "Free Agent";
const ALL_TEAMS = Array.from(new Set(Object.values(TEAM_NAME_BY_ABBR))).sort();
const DEST_OPTIONS = [FREE_AGENT, ...ALL_TEAMS];

const inputBase = {
  background: "#1e293b",
  color: "#e2e8f0",
  border: "1px solid #334155",
  borderRadius: 6,
  fontSize: 12,
};

// Joukkue kerrallaan -päivitys: liitä joukkueen offseason-lista (tai merkitse
// käsin), sovellus rakentaa uuden rosterin, jonka minuutit säädetään yhdellä
// näkymällä. Tallennus kirjaa jokaisen muutoksen samana transaktiona kuin
// yksittäinen siirto (raaka EPM × minuutit/48).
export default function TeamUpdate({
  players,
  secret,
  setSecret,
  onSaved,
}: {
  players: DbPlayer[];
  secret: string;
  setSecret: (s: string) => void;
  onSaved: () => Promise<void>;
}) {
  const [team, setTeam] = useState(ALL_TEAMS[0] ?? "");
  const [paste, setPaste] = useState("");
  // pelaajan id -> kohdejoukkue (tai FREE_AGENT)
  const [departures, setDepartures] = useState<Record<string, string>>({});
  // pelaajan id -> mistä tulee (näyttöä varten)
  const [additions, setAdditions] = useState<Record<string, string>>({});
  const [minutes, setMinutes] = useState<Record<string, number>>({});
  // lähtijän odotetut minuutit UUDESSA joukkueessa (pelaajan id -> min)
  const [destMinutes, setDestMinutes] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamPlayers = useMemo(() => players.filter((p) => p.team === team), [players, team]);

  function reset(newTeam?: string) {
    if (newTeam) setTeam(newTeam);
    setDepartures({});
    setAdditions({});
    setMinutes({});
    setDestMinutes({});
    setNotes([]);
    setStatus(null);
  }

  function findPlayer(name: string, preferTeam?: string, excludeTeam?: string): DbPlayer | null {
    const n = normalizePlayerName(name);
    const matches = players.filter((p) => normalizePlayerName(p.name) === n);
    if (matches.length === 0) return null;
    if (preferTeam) {
      const m = matches.find((p) => p.team === preferTeam);
      if (m) return m;
    }
    if (excludeTeam) {
      const m = matches.find((p) => p.team !== excludeTeam);
      if (m) return m;
    }
    return matches[0];
  }

  function applyPaste() {
    const { moves, skipped } = parseTeamTransactions(paste);
    const newDeps = { ...departures };
    const newAdds = { ...additions };
    const msgs: string[] = [];

    for (const mv of moves) {
      if (mv.kind === "resign") continue; // jatkosopimus: pelaaja pysyy, ei muutosta
      if (mv.kind === "departure") {
        const p = findPlayer(mv.name, team);
        if (!p || p.team !== team) {
          msgs.push(`Lähtijä "${mv.name}" ei ole kannassa joukkueessa ${team} — ohitettu (jo käsitelty tai puuttuu).`);
          continue;
        }
        newDeps[p.id] = mv.otherTeam ?? FREE_AGENT;
        if (mv.otherTeamRaw && !mv.otherTeam) {
          msgs.push(`"${mv.otherTeamRaw}" ei tunnistettu joukkueeksi — ${p.name} merkitty vapaaksi agentiksi, vaihda tarvittaessa.`);
        }
      } else {
        const p = findPlayer(mv.name, undefined, team);
        if (!p) {
          msgs.push(`Tulija "${mv.name}" puuttuu kannasta — lisää hänet ensin Players → Lisää pelaaja (joukkueeksi ${team}).`);
          continue;
        }
        if (p.team === team) {
          msgs.push(`${p.name} on jo joukkueessa ${team} — ei muutosta.`);
          continue;
        }
        newAdds[p.id] = p.team;
      }
    }
    for (const s of skipped) msgs.push(`Riviä ei tunnistettu: "${s}"`);
    if (moves.length === 0) msgs.push("Liitteestä ei löytynyt yhtään siirtoa. Tarkista että mukana on otsikot Additions / Departures.");

    setDepartures(newDeps);
    setAdditions(newAdds);
    setNotes(msgs);
    setStatus(null);
  }

  const newRoster = useMemo(() => {
    const staying = teamPlayers.filter((p) => !(p.id in departures));
    const incoming = Object.keys(additions)
      .map((id) => byId.get(id))
      .filter((p): p is DbPlayer => !!p);
    return [...staying, ...incoming];
  }, [teamPlayers, departures, additions, byId]);

  const minOf = (p: DbPlayer) => minutes[p.id] ?? p.mpg_base;

  const sortedRoster = useMemo(
    () => [...newRoster].sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || minOf(b) - minOf(a)),
    [newRoster, minutes]
  );

  const totalMin = newRoster.filter((p) => p.active).reduce((s, p) => s + minOf(p), 0);

  const destMinOf = (p: DbPlayer, dest: string) => destMinutes[p.id] ?? (dest === FREE_AGENT ? 0 : p.mpg_base);

  // Minuuttisaldo: paljonko lähti, paljonko tuli, paljonko on vielä jakamatta.
  const outMin = Object.keys(departures)
    .map((id) => byId.get(id))
    .filter((p): p is DbPlayer => !!p && p.active)
    .reduce((s, p) => s + p.mpg_base, 0);
  const inMin = Object.keys(additions)
    .map((id) => byId.get(id))
    .filter((p): p is DbPlayer => !!p && p.active)
    .reduce((s, p) => s + minOf(p), 0);
  const unallocated = 240 - totalMin;

  // Skaalaa annettujen pelaajien minuutit suhteessa nykyisiin niin, että
  // niiden summa = target. Yksikään pelaaja ei ylitä 40 min; ylijäämä jaetaan
  // muille. Jos kaikilla on 0 min, jaetaan tasan.
  function scaleTo(group: DbPlayer[], target: number) {
    const CAP = 40;
    const result: Record<string, number> = {};
    let remaining = [...group];
    let tgt = Math.max(0, target);
    for (let iter = 0; iter < 10 && remaining.length > 0; iter++) {
      const sum = remaining.reduce((s, p) => s + minOf(p), 0);
      const capped: DbPlayer[] = [];
      for (const p of remaining) {
        const v = sum > 0 ? (minOf(p) * tgt) / sum : tgt / remaining.length;
        if (v > CAP) capped.push(p);
      }
      if (capped.length === 0) {
        for (const p of remaining) {
          const v = sum > 0 ? (minOf(p) * tgt) / sum : tgt / remaining.length;
          result[p.id] = Math.round(v * 10) / 10;
        }
        break;
      }
      for (const p of capped) {
        result[p.id] = CAP;
        tgt -= CAP;
      }
      remaining = remaining.filter((p) => !capped.includes(p));
    }
    setMinutes((prev) => ({ ...prev, ...result }));
  }

  function distributeToStaying() {
    const staying = newRoster.filter((p) => p.active && !(p.id in additions));
    const incomingSum = newRoster.filter((p) => p.active && p.id in additions).reduce((s, p) => s + minOf(p), 0);
    scaleTo(staying, 240 - incomingSum);
  }

  function distributeToAll() {
    scaleTo(
      newRoster.filter((p) => p.active),
      240
    );
  }

  // Joukkueen arvioitu muutos: uuden rosterin minuuttipainotettu EPM miinus
  // vanhan. Tämä on sama summa jonka tallennettavat transaktiot kirjaavat
  // tälle joukkueelle.
  const impact = useMemo(() => {
    const oldO = teamPlayers.reduce((s, p) => s + p.oepm * (p.mpg_base / 48), 0);
    const oldD = teamPlayers.reduce((s, p) => s + p.depm * (p.mpg_base / 48), 0);
    const newO = newRoster.reduce((s, p) => s + p.oepm * (minOf(p) / 48), 0);
    const newD = newRoster.reduce((s, p) => s + p.depm * (minOf(p) / 48), 0);
    return { o: newO - oldO, d: newD - oldD };
  }, [teamPlayers, newRoster, minutes]);

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = normalizePlayerName(search);
    return players
      .filter((p) => p.team !== team && !(p.id in additions) && normalizePlayerName(p.name).includes(q))
      .slice(0, 12);
  }, [search, players, team, additions]);

  type Op = { playerId: string; newTeam: string; newMpg: number; label: string };
  const ops: Op[] = useMemo(() => {
    const list: Op[] = [];
    for (const [id, dest] of Object.entries(departures)) {
      const p = byId.get(id);
      if (!p) continue;
      const dm = destMinOf(p, dest);
      list.push({ playerId: id, newTeam: dest, newMpg: dm, label: `${p.name} → ${dest} (${dm} min)` });
    }
    for (const id of Object.keys(additions)) {
      const p = byId.get(id);
      if (!p) continue;
      list.push({ playerId: id, newTeam: team, newMpg: minOf(p), label: `${p.name} ${p.team} → ${team} (${minOf(p)} min)` });
    }
    for (const p of teamPlayers) {
      if (p.id in departures) continue;
      if (minutes[p.id] !== undefined && minutes[p.id] !== p.mpg_base) {
        list.push({ playerId: p.id, newTeam: team, newMpg: minutes[p.id], label: `${p.name} minuutit ${p.mpg_base} → ${minutes[p.id]}` });
      }
    }
    return list;
  }, [departures, additions, minutes, destMinutes, teamPlayers, team, byId]);

  async function save() {
    setSaving(true);
    setStatus(null);
    localStorage.setItem("cron_secret", secret);
    const failed: string[] = [];
    for (const op of ops) {
      try {
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ playerId: op.playerId, newTeam: op.newTeam, newMpg: op.newMpg }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          failed.push(`${op.label}: ${data.error ?? res.status}`);
        }
      } catch (e: any) {
        failed.push(`${op.label}: ${e?.message ?? "virhe"}`);
      }
    }
    await onSaved();
    setSaving(false);
    if (failed.length === 0) {
      reset();
      setPaste("");
      setStatus(`${team} päivitetty: ${ops.length} muutosta kirjattu.`);
    } else {
      setStatus(`Virhe: ${failed.length}/${ops.length} epäonnistui — ${failed.join("; ")}`);
    }
  }

  const signed = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;

  return (
    <div style={{ maxWidth: 820 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <label style={{ fontSize: 12, color: "#94a3b8" }}>Joukkue</label>
        <select value={team} onChange={(e) => reset(e.target.value)} style={{ ...inputBase, padding: "6px 8px", fontSize: 13 }}>
          {ALL_TEAMS.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: "#64748b" }}>{teamPlayers.length} pelaajaa kannassa</span>
      </div>

      <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
        Liitä joukkueen siirtolista (Re-signing / Additions / Departures) — valinnainen
      </label>
      <textarea
        value={paste}
        onChange={(e) => setPaste(e.target.value)}
        placeholder={"Additions\nLuguentz Dort joins via trade with Thunder\nDepartures\nBuddy Hield departs via trade with Hornets"}
        style={{ ...inputBase, width: "100%", height: 110, padding: 8, fontFamily: "monospace" }}
      />
      <button
        onClick={applyPaste}
        disabled={!paste.trim()}
        style={{
          marginTop: 6,
          background: paste.trim() ? "#2563eb" : "#334155",
          color: "white",
          border: "none",
          borderRadius: 6,
          padding: "6px 14px",
          fontSize: 13,
          cursor: paste.trim() ? "pointer" : "not-allowed",
        }}
      >
        Tunnista siirrot
      </button>

      {notes.length > 0 && (
        <ul style={{ fontSize: 12, color: "#fbbf24", margin: "10px 0", paddingLeft: 18 }}>
          {notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}

      {Object.keys(departures).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6, color: "#f87171" }}>Lähtijät</div>
          {Object.entries(departures).map(([id, dest]) => {
            const p = byId.get(id);
            if (!p) return null;
            return (
              <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, padding: "3px 0" }}>
                <span style={{ minWidth: 200 }}>
                  {p.name} <span style={{ color: "#64748b" }}>({p.mpg_base} min)</span>
                </span>
                <span style={{ color: "#64748b" }}>→</span>
                <select
                  value={dest}
                  onChange={(e) => setDepartures((prev) => ({ ...prev, [id]: e.target.value }))}
                  style={{ ...inputBase, padding: "3px 6px" }}
                >
                  {DEST_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                {dest !== FREE_AGENT && (
                  <>
                    <input
                      type="number"
                      value={destMinOf(p, dest)}
                      onChange={(e) => setDestMinutes((prev) => ({ ...prev, [id]: parseFloat(e.target.value) || 0 }))}
                      style={{ ...inputBase, width: 56, padding: "3px 6px" }}
                    />
                    <span style={{ color: "#64748b" }}>min uudessa joukkueessa</span>
                  </>
                )}
                <button
                  onClick={() =>
                    setDepartures((prev) => {
                      const next = { ...prev };
                      delete next[id];
                      return next;
                    })
                  }
                  style={{ ...inputBase, padding: "2px 8px", cursor: "pointer" }}
                >
                  peru
                </button>
              </div>
            );
          })}
        </div>
      )}

      <div style={{ marginTop: 20, border: "1px solid #334155", borderRadius: 8, padding: 14 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Uusi rosteri — {team}</div>
          <div
            style={{
              fontSize: 13,
              fontWeight: 600,
              color: Math.abs(totalMin - 240) <= 5 ? "#4ade80" : Math.abs(totalMin - 240) <= 15 ? "#fbbf24" : "#f87171",
            }}
          >
            Minuutit {totalMin.toFixed(0)} / 240
          </div>
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", margin: "4px 0 10px" }}>
          Arvioitu muutos: O-EPM <strong style={{ color: impact.o >= 0 ? "#4ade80" : "#f87171" }}>{signed(impact.o)}</strong> · D-EPM{" "}
          <strong style={{ color: impact.d >= 0 ? "#4ade80" : "#f87171" }}>{signed(impact.d)}</strong>{" "}
          <span style={{ color: "#64748b" }}>(positiivinen D parantaa puolustusta)</span>
        </div>

        <div
          style={{
            display: "flex",
            gap: 16,
            flexWrap: "wrap",
            alignItems: "center",
            fontSize: 12,
            background: "#111827",
            borderRadius: 6,
            padding: "8px 10px",
            marginBottom: 10,
          }}
        >
          <span>
            Lähti: <strong style={{ color: "#f87171" }}>{outMin.toFixed(0)} min</strong>
          </span>
          <span>
            Tuli: <strong style={{ color: "#4ade80" }}>{inMin.toFixed(0)} min</strong>
          </span>
          <span>
            {unallocated >= 0 ? "Jakamatta" : "Liikaa"}:{" "}
            <strong style={{ color: Math.abs(unallocated) <= 5 ? "#4ade80" : "#fbbf24" }}>
              {Math.abs(unallocated).toFixed(0)} min
            </strong>
          </span>
          <span style={{ flex: 1 }} />
          <button
            onClick={distributeToStaying}
            title="Tulijoiden minuutit pysyvät, erotus jaetaan pysyville pelaajille suhteessa heidän nykyisiin minuutteihinsa (max 40 min/pelaaja)"
            style={{ ...inputBase, padding: "4px 10px", cursor: "pointer" }}
          >
            Jaa pysyville
          </button>
          <button
            onClick={distributeToAll}
            title="Kaikkien aktiivisten minuutit skaalataan samassa suhteessa summaan 240 (max 40 min/pelaaja)"
            style={{ ...inputBase, padding: "4px 10px", cursor: "pointer" }}
          >
            Skaalaa kaikki 240:een
          </button>
          <button
            onClick={() => setMinutes({})}
            style={{ ...inputBase, padding: "4px 10px", cursor: "pointer" }}
          >
            Palauta
          </button>
        </div>

        <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
          <thead>
            <tr style={{ color: "#94a3b8", textAlign: "left" }}>
              <th style={{ padding: 4 }}>Pelaaja</th>
              <th style={{ padding: 4 }}>O / D</th>
              <th style={{ padding: 4 }}>Minuutit</th>
              <th style={{ padding: 4 }}>Vaikutus</th>
              <th style={{ padding: 4 }}></th>
            </tr>
          </thead>
          <tbody>
            {sortedRoster.map((p) => {
              const incoming = p.id in additions;
              const changed = minutes[p.id] !== undefined && minutes[p.id] !== p.mpg_base;
              const m = minOf(p);
              return (
                <tr key={p.id} style={{ borderTop: "1px solid #1e293b", opacity: p.active ? 1 : 0.5 }}>
                  <td style={{ padding: 4 }}>
                    {p.name} <span style={{ color: "#64748b" }}>{p.pos}</span>
                    {incoming && <span style={{ color: "#4ade80" }}> · tulee ({additions[p.id]})</span>}
                    {!p.active && <span style={{ color: "#64748b" }}> · inaktiivinen</span>}
                  </td>
                  <td style={{ padding: 4, color: "#94a3b8" }}>
                    {p.oepm} / {p.depm}
                  </td>
                  <td style={{ padding: 4 }}>
                    <input
                      type="number"
                      value={m}
                      onChange={(e) => setMinutes((prev) => ({ ...prev, [p.id]: parseFloat(e.target.value) || 0 }))}
                      style={{
                        ...inputBase,
                        width: 60,
                        padding: "3px 6px",
                        background: changed || incoming ? "#1e3a2e" : "#1e293b",
                        border: `1px solid ${changed || incoming ? "#4ade80" : "#334155"}`,
                      }}
                    />
                    {(changed || incoming) && (
                      <span style={{ fontSize: 10, color: "#64748b", marginLeft: 4 }}>
                        {incoming ? `ennen ${p.mpg_base} (${additions[p.id]})` : `ennen ${p.mpg_base}`}
                      </span>
                    )}
                  </td>
                  <td style={{ padding: 4, color: (p.oepm + p.depm) >= 0 ? "#4ade80" : "#f87171" }}>
                    {signed(((p.oepm + p.depm) * m) / 48)}
                  </td>
                  <td style={{ padding: 4, textAlign: "right" }}>
                    {incoming ? (
                      <button
                        onClick={() =>
                          setAdditions((prev) => {
                            const next = { ...prev };
                            delete next[p.id];
                            return next;
                          })
                        }
                        style={{ ...inputBase, padding: "2px 8px", cursor: "pointer" }}
                      >
                        peru
                      </button>
                    ) : (
                      <button
                        onClick={() => setDepartures((prev) => ({ ...prev, [p.id]: FREE_AGENT }))}
                        style={{ ...inputBase, padding: "2px 8px", cursor: "pointer" }}
                      >
                        lähtee
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>

        <div style={{ marginTop: 12 }}>
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Lisää tulija käsin: hae nimellä..."
            style={{ ...inputBase, width: 280, padding: "6px 8px" }}
          />
          {searchResults.length > 0 && (
            <div style={{ border: "1px solid #334155", borderRadius: 6, marginTop: 4, maxWidth: 420 }}>
              {searchResults.map((p) => (
                <div
                  key={p.id}
                  onClick={() => {
                    setAdditions((prev) => ({ ...prev, [p.id]: p.team }));
                    setSearch("");
                  }}
                  style={{ padding: "5px 10px", fontSize: 12, cursor: "pointer", display: "flex", justifyContent: "space-between", borderBottom: "1px solid #1e293b" }}
                >
                  <span>{p.name}</span>
                  <span style={{ color: "#64748b" }}>
                    {p.team} · {p.mpg_base} min
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div style={{ marginTop: 16 }}>
        {ops.length > 0 && (
          <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>
            Tallennettavat muutokset ({ops.length}):
            <ul style={{ margin: "4px 0", paddingLeft: 18 }}>
              {ops.map((o) => (
                <li key={o.playerId}>{o.label}</li>
              ))}
            </ul>
          </div>
        )}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="CRON_SECRET"
            style={{ ...inputBase, width: 160, padding: "6px 8px" }}
          />
          <button
            onClick={save}
            disabled={saving || !secret || ops.length === 0}
            style={{
              background: saving || !secret || ops.length === 0 ? "#334155" : "#2563eb",
              color: "white",
              border: "none",
              borderRadius: 6,
              padding: "8px 16px",
              fontSize: 13,
              cursor: saving || !secret || ops.length === 0 ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Tallennetaan..." : `Tallenna ${team} (${ops.length} muutosta)`}
          </button>
        </div>
        {status && (
          <div style={{ marginTop: 8, fontSize: 12, color: status.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>{status}</div>
        )}
      </div>
    </div>
  );
}
