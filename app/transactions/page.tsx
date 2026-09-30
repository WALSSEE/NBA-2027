"use client";

import { useEffect, useMemo, useState } from "react";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";
import TeamUpdate from "./TeamUpdate";
import { computeOffseason, leagueNormalize, canonTeam, type PrevRow } from "@/lib/prevSeason";
import { loadPreSettingsRemote } from "@/lib/preseason";
import { withRatings } from "@/lib/ratings";

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

  const [mode, setMode] = useState<"team" | "single">("team");
  const [resetAsk, setResetAsk] = useState<null | "log" | "full">(null);
  const [resetBusy, setResetBusy] = useState(false);
  const [resetStatus, setResetStatus] = useState<string | null>(null);

  async function runReset(kind: "log" | "full") {
    setResetBusy(true);
    setResetStatus(null);
    localStorage.setItem("cron_secret", secret);
    try {
      const res = await fetch("/api/offseason/reset", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify({ mode: kind, confirm: "RESET" }),
      });
      const data = await res.json().catch(() => ({ error: `palvelin vastasi ${res.status}` }));
      if (!res.ok) setResetStatus(`Virhe: ${data.error ?? res.status}`);
      else if (kind === "log") setResetStatus("Transaktioloki tyhjennetty. Rosterit ennallaan.");
      else
        setResetStatus(
          `Lähtötilanne palautettu: loki tyhjennetty, ${data.restored} pelaajaa kauden 25-26 viimeiseen joukkueeseensa, minuuteiksi koko kauden minuutit / 82` +
            (data.deactivatedDuplicates ? `, ${data.deactivatedDuplicates} vanhaa tuplariviä poistettu käytöstä` : "") +
            (data.zeroed ? `, ${data.zeroed} muun pelaajan minuutit nollattu` : "") +
            (data.added?.length ? `. Lisätty kantaan EPM 0:lla (${data.added.length}): ${data.added.join(", ")}.` : ".")
        );
      setResetAsk(null);
      await Promise.all([loadPlayers(), loadTransactions()]);
    } catch (e: any) {
      setResetStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setResetBusy(false);
    }
  }
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newTeam, setNewTeam] = useState(ALL_TEAMS[0] ?? "");
  const [newMpg, setNewMpg] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  // --- Rosteripaneeli: näyttää valitun joukkueen minuuttijakauman, jotta
  // vapautuneet minuutit (esim. 3 pelaajaa lähtee eikä rotaatiopelaajia tule
  // tilalle) voi jakaa käsin jäljelle jääville pelaajille ja nähdä milloin
  // summa on taas lähellä 240:tä.
  const [rosterTeam, setRosterTeam] = useState(ALL_TEAMS[0] ?? "");
  const [rosterEdits, setRosterEdits] = useState<Record<string, number>>({});
  const [rosterSaving, setRosterSaving] = useState(false);
  const [rosterStatus, setRosterStatus] = useState<string | null>(null);

  useEffect(() => {
    setSecret(localStorage.getItem("cron_secret") ?? "");
    loadPlayers();
    loadTransactions();
    loadPrevRows();
  }, []);

  async function loadPlayers() {
    setLoadingPlayers(true);
    try {
      const [res, st] = await Promise.all([fetch("/api/players/import"), loadPreSettingsRemote()]);
      const data = await res.json();
      // Pelaaja-arviot valitusta lähteestä (EPM / DARKO / keskiarvo), kuten Matchupissa.
      setPlayers(withRatings(data.players ?? [], st.ratingSource ?? "avg"));
    } catch {
      // ei haittaa
    } finally {
      setLoadingPlayers(false);
    }
  }

  const [prevRows, setPrevRows] = useState<PrevRow[]>([]);
  async function loadPrevRows() {
    try {
      const res = await fetch("/api/prev-season");
      const data = await res.json();
      setPrevRows((data.rows ?? []).map((r: any) => ({ ...r, gp: Number(r.gp) || 0, min_total: Number(r.min_total) || 0 })));
    } catch {
      setPrevRows([]);
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
    // Rosteripaneeli seuraa automaattisesti lähtevän pelaajan joukkuetta,
    // koska siellä vapautuvat minuutit yleensä pitää jakaa uudelleen.
    setRosterTeam(p.team);
    setRosterEdits({});
    setRosterStatus(null);
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

  const rosterPlayers = useMemo(
    () =>
      players
        .filter((p) => p.team === rosterTeam)
        .sort((a, b) => (b.active ? 1 : 0) - (a.active ? 1 : 0) || (rosterEdits[b.id] ?? b.mpg_base) - (rosterEdits[a.id] ?? a.mpg_base)),
    [players, rosterTeam, rosterEdits]
  );

  const rosterTotalMinutes = useMemo(
    () => rosterPlayers.filter((p) => p.active).reduce((sum, p) => sum + (rosterEdits[p.id] ?? p.mpg_base), 0),
    [rosterPlayers, rosterEdits]
  );

  const rosterChangedCount = useMemo(
    () => rosterPlayers.filter((p) => rosterEdits[p.id] !== undefined && rosterEdits[p.id] !== p.mpg_base).length,
    [rosterPlayers, rosterEdits]
  );

  function setRosterMinutes(playerId: string, value: number) {
    setRosterEdits((prev) => ({ ...prev, [playerId]: value }));
  }

  // Tallentaa kaikki rosteripaneelissa muutetut minuutit yksi kerrallaan
  // samana "sama joukkue, uudet minuutit" -transaktiona kuin muutkin
  // minuuttipäivitykset — näin vapautuneet minuutit saa jaettua jäljelle
  // jääville pelaajille ilman että joutuu käymään erikseen jokaista
  // pelaajaa läpi hakukentän kautta.
  async function saveRosterMinutes() {
    setRosterSaving(true);
    setRosterStatus(null);
    localStorage.setItem("cron_secret", secret);
    const changed = rosterPlayers.filter((p) => rosterEdits[p.id] !== undefined && rosterEdits[p.id] !== p.mpg_base);
    if (changed.length === 0) {
      setRosterStatus("Ei muutoksia tallennettavaksi.");
      setRosterSaving(false);
      return;
    }
    let okCount = 0;
    for (const p of changed) {
      try {
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ playerId: p.id, newTeam: p.team, newMpg: rosterEdits[p.id] }),
        });
        if (res.ok) okCount += 1;
      } catch {
        // jatketaan silti loput
      }
    }
    setRosterStatus(`Tallennettu ${okCount}/${changed.length} pelaajan minuutit.`);
    setRosterEdits({});
    await Promise.all([loadPlayers(), loadTransactions()]);
    setRosterSaving(false);
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>Transaktiot — treidit ja minuuttimuutokset</h1>
      <p style={{ color: "#64748b", fontSize: 13, marginBottom: 24, maxWidth: 720 }}>
        Kun pelaaja siirtyy joukkueesta toiseen (tai hänen odotetut minuuttinsa muuttuvat), kirjaa
        se tähän. Vaikutus lasketaan automaattisesti: <code>raaka EPM × (minuutit / 48)</code> —
        lähtevä joukkue saa negatiivisen, vastaanottava positiivisen deltan. Pelaajan joukkue ja
        minuutit päivittyvät samalla Pelaajat-sivulle.
      </p>

      <details style={{ marginBottom: 20, border: "1px solid #334155", borderRadius: 8, padding: "10px 14px", maxWidth: 820 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Aloita alusta (tyhjennä loki / palauta lähtötilanne)</summary>
        <div style={{ fontSize: 12, color: "#94a3b8", margin: "10px 0" }}>
          <strong>Palauta lähtötilanne</strong>: tyhjentää transaktiolokin ja siirtää jokaisen kaudella 25-26 pelanneen
          pelaajan kauden viimeiseen joukkueeseensa. Minuuteiksi tulee hänen koko kauden minuuttinsa / 82 — täsmälleen se
          paino, jolla hän oli joukkueen 25-26 luvuissa — joten kesän muutos on 0 (paitsi kesken kauden treidatuilla, joiden
          vaikutus on todellinen). Sen jälkeen tee kesän siirrot ja roolit Joukkue kerrallaan -näkymässä: esim. koko kauden
          loukkaantuneena ollut tähti saa terveenä enemmän minuutteja, ja vain nämä muutokset liikuttavat lukuja. Pohjan näet
          Players → Pohja 25-26.
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
          <input
            type="password"
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            placeholder="CRON_SECRET"
            style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "6px 8px", fontSize: 12, width: 150 }}
          />
          <button
            onClick={() => setResetAsk("full")}
            disabled={resetBusy || !secret}
            style={{ background: "#7f1d1d", color: "white", border: "none", borderRadius: 6, padding: "7px 12px", fontSize: 12, cursor: "pointer" }}
          >
            Palauta lähtötilanne + tyhjennä loki
          </button>
          <button
            onClick={() => setResetAsk("log")}
            disabled={resetBusy || !secret}
            style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "7px 12px", fontSize: 12, cursor: "pointer" }}
          >
            Tyhjennä vain loki
          </button>
        </div>
        {resetAsk && (
          <div style={{ marginTop: 10, background: "#450a0a", borderRadius: 6, padding: "10px 12px", fontSize: 12 }}>
            {resetAsk === "full"
              ? "Varmista: kaikki kirjatut siirrot poistetaan ja rosterit ja minuutit palautetaan kauden 25-26 tilanteeseen. Tehtyjä kesän muutoksia ei voi palauttaa."
              : "Varmista: kaikki kirjatut siirrot poistetaan lokista. Pelaajien joukkueet ja minuutit eivät muutu."}
            <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
              <button
                onClick={() => runReset(resetAsk)}
                disabled={resetBusy}
                style={{ background: "#dc2626", color: "white", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}
              >
                {resetBusy ? "Tehdään..." : "Kyllä, tee se"}
              </button>
              <button
                onClick={() => setResetAsk(null)}
                style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}
              >
                Peru
              </button>
            </div>
          </div>
        )}
        {resetStatus && (
          <div style={{ marginTop: 8, fontSize: 12, color: resetStatus.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>{resetStatus}</div>
        )}
      </details>

      <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: "1px solid #334155" }}>
        {[
          { key: "team" as const, label: "Joukkue kerrallaan" },
          { key: "single" as const, label: "Yksittäinen siirto" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setMode(t.key)}
            style={{
              padding: "8px 16px",
              fontSize: 13,
              background: "transparent",
              border: "none",
              borderBottom: mode === t.key ? "2px solid #2563eb" : "2px solid transparent",
              color: mode === t.key ? "#e2e8f0" : "#64748b",
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {mode === "team" && (
        <div style={{ marginBottom: 32 }}>
          <TeamUpdate
            players={players}
            secret={secret}
            setSecret={setSecret}
            onSaved={async () => {
              await Promise.all([loadPlayers(), loadTransactions()]);
            }}
            txPlayerNames={new Set(transactions.map((t) => `${t.player_name}::${t.team}`))}
            prevRows={prevRows}
          />
        </div>
      )}

      {mode === "single" && (
      <>
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

      <div style={{ maxWidth: 640, marginBottom: 32, border: "1px solid #334155", borderRadius: 8, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Joukkueen rosteri ja minuutit</div>
          <select
            value={rosterTeam}
            onChange={(e) => {
              setRosterTeam(e.target.value);
              setRosterEdits({});
              setRosterStatus(null);
            }}
            style={{
              background: "#1e293b",
              color: "#e2e8f0",
              border: "1px solid #334155",
              borderRadius: 6,
              padding: "4px 8px",
              fontSize: 12,
            }}
          >
            {ALL_TEAMS.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <p style={{ color: "#64748b", fontSize: 11, marginBottom: 12 }}>
          Kun pelaajia lähtee eikä tilalle tule rotaatiopelaajia, vapautuneet minuutit pitää
          jakaa käsin jäljelle jääville — muokkaa minuutteja suoraan tästä, seuraa summaa (tavoite
          n. 240) ja tallenna.
        </p>
        <div
          style={{
            fontSize: 13,
            fontWeight: 600,
            marginBottom: 8,
            color: Math.abs(rosterTotalMinutes - 240) <= 5 ? "#4ade80" : Math.abs(rosterTotalMinutes - 240) <= 15 ? "#fbbf24" : "#f87171",
          }}
        >
          Aktiivisten pelaajien minuutit yhteensä: {rosterTotalMinutes.toFixed(0)} / 240
        </div>
        <div style={{ maxHeight: 320, overflow: "auto" }}>
          {rosterPlayers.length === 0 && (
            <div style={{ color: "#64748b", fontSize: 12 }}>Ei pelaajia tässä joukkueessa.</div>
          )}
          {rosterPlayers.map((p) => {
            const val = rosterEdits[p.id] ?? p.mpg_base;
            const changed = rosterEdits[p.id] !== undefined && rosterEdits[p.id] !== p.mpg_base;
            return (
              <div
                key={p.id}
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  gap: 8,
                  padding: "4px 0",
                  borderBottom: "1px solid #1e293b",
                  opacity: p.active ? 1 : 0.5,
                }}
              >
                <span style={{ fontSize: 12 }}>
                  {p.name} <span style={{ color: "#64748b" }}>({p.pos || "—"})</span>
                  {!p.active && <span style={{ color: "#64748b" }}> · inaktiivinen</span>}
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={{ fontSize: 11, color: "#64748b" }}>
                    {p.oepm}/{p.depm}
                  </span>
                  <input
                    type="number"
                    value={val}
                    onChange={(e) => setRosterMinutes(p.id, parseFloat(e.target.value) || 0)}
                    style={{
                      width: 56,
                      background: changed ? "#1e3a2e" : "#1e293b",
                      color: "#e2e8f0",
                      border: `1px solid ${changed ? "#4ade80" : "#334155"}`,
                      borderRadius: 4,
                      padding: "3px 6px",
                      fontSize: 12,
                    }}
                  />
                </span>
              </div>
            );
          })}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
          <button
            onClick={saveRosterMinutes}
            disabled={rosterSaving || !secret || rosterChangedCount === 0}
            style={{
              background: rosterSaving || !secret || rosterChangedCount === 0 ? "#334155" : "#2563eb",
              color: "white",
              border: "none",
              borderRadius: 6,
              padding: "8px 16px",
              fontSize: 13,
              cursor: rosterSaving || !secret || rosterChangedCount === 0 ? "not-allowed" : "pointer",
            }}
          >
            {rosterSaving ? "Tallennetaan..." : `Tallenna minuuttimuutokset (${rosterChangedCount})`}
          </button>
          {rosterStatus && (
            <span style={{ fontSize: 12, color: rosterStatus.startsWith("Ei") ? "#94a3b8" : "#4ade80" }}>{rosterStatus}</span>
          )}
        </div>
      </div>

      </>
      )}

      <h2 style={{ fontSize: 16, marginTop: 32, marginBottom: 4 }}>Kesän muutos joukkueittain</h2>
      {(() => {
        if (loadingPlayers) return <div style={{ color: "#64748b", fontSize: 13 }}>Ladataan...</div>;
        if (prevRows.length === 0)
          return <div style={{ color: "#fbbf24", fontSize: 13 }}>Kauden 25-26 minuutit puuttuvat (setup_season_baseline.sql).</div>;
        const raw = computeOffseason(players as any, prevRows);
        const { teams, meanO, meanD } = leagueNormalize(raw);
        const list = Object.values(teams)
          .filter((t) => canonTeam(t.team))
          .sort((x, y) => y.offO + y.offD - (x.offO + x.offD));
        const sg = (x: number) => `${x >= 0 ? "+" : ""}${x.toFixed(2)}`;
        return (
          <>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10, maxWidth: 900 }}>
              Sama luku, jota Matchup käyttää: nykyinen rosteri (EPM × minuutit, skaalattu 240:een) − kauden 25-26 pohja,
              miinus liigan keskimääräinen muutos (O {sg(meanO)}, D {sg(meanD)}). Net-summa on aina 0, joten puolet joukkueista
              heikkenee suhteessa muihin. D positiivinen = parempi puolustus (DRTG laskee).
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8, maxWidth: 1000, marginBottom: 32 }}>
              {list.map((t) => {
                const net = t.offO + t.offD;
                return (
                  <div key={t.team} style={{ fontSize: 12, border: "1px solid #334155", borderRadius: 6, padding: "6px 10px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", fontWeight: 600, marginBottom: 2 }}>
                      <span>{t.team}</span>
                      <span style={{ color: Math.abs(net) < 0.05 ? "#94a3b8" : net > 0 ? "#4ade80" : "#f87171" }}>{sg(net)}</span>
                    </div>
                    <div style={{ color: "#94a3b8" }}>
                      O {sg(t.offO)} / D {sg(t.offD)} · {t.roleMin.toFixed(0)} min
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        );
      })()}

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
                <th style={{ padding: 4 }} title="Kirjaushetken arvio, ei käytetä laskennassa">Δ O*</th>
                <th style={{ padding: 4 }} title="Kirjaushetken arvio, ei käytetä laskennassa">Δ D*</th>
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
