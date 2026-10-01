"use client";

import { useMemo, useState } from "react";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";
import { parseTeamTransactions, normalizePlayerName, type ParsedMove } from "@/lib/parseTransactions";
import { ROOKIE_PRESETS, rookieByPick } from "@/lib/rookies";
import { TEAM_GAMES, looseKey, computeOffseason, leagueNormalize, type PrevRow } from "@/lib/prevSeason";

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

// Joukkuenimien vertailu siedettävästi (ylimääräiset/erikoisvälilyönnit, kirjainkoko),
// ettei samaa joukkuetta tulkita eri joukkueeksi.
const normTeam = (t: string) => (t ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const sameTeam = (a: string, b: string) => normTeam(a) === normTeam(b);

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
  txPlayerNames,
  prevRows = [],
}: {
  players: DbPlayer[];
  secret: string;
  setSecret: (s: string) => void;
  onSaved: () => Promise<void>;
  // Pelaajat, joille on jo kirjattu transaktioita (nimi::joukkue) — heitä ei
  // tarjota "tulokas"-kirjaukseen.
  txPlayerNames: Set<string>;
  prevRows?: PrevRow[];
}) {
  // Kauden 25-26 minuutit pelaajittain (pohja).
  const findPrev = useMemo(() => {
    const byName = new Map<string, PrevRow[]>();
    for (const r of prevRows) {
      for (const k of [normalizePlayerName(r.name), `L:${looseKey(r.name)}`]) (byName.get(k) ?? byName.set(k, []).get(k)!).push(r);
    }
    return (name: string): PrevRow[] => {
      const exact = byName.get(normalizePlayerName(name));
      if (exact) return exact;
      const loose = byName.get(`L:${looseKey(name)}`);
      return loose && new Set(loose.map((r) => normalizePlayerName(r.name))).size === 1 ? loose : [];
    };
  }, [prevRows]);
  function prevInfo(p: DbPlayer): string | null {
    if (prevRows.length === 0) return null;
    const rows = findPrev(p.name);
    if (rows.length === 0) return "25-26: ei pelejä → pohja 0";
    const total = rows.reduce((a, r) => a + r.min_total, 0);
    return (
      "25-26: " +
      rows.map((r) => `${r.team.split(" ").pop()} ${r.gp} × ${(r.gp ? r.min_total / r.gp : 0).toFixed(1)} min`).join(", ") +
      ` → pohja ${(total / TEAM_GAMES).toFixed(1)}`
    );
  }
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

  // --- Tulokkaat ---
  // Uudet pelaajat (ei vielä kannassa). id muotoa "new:N".
  const [rookies, setRookies] = useState<DbPlayer[]>([]);
  // Jo kannassa olevat (esim. Players-sivulta lisätyt) pelaajat, joiden tulo
  // kirjataan joukkueen lukuihin.
  const [rookieMark, setRookieMark] = useState<Record<string, boolean>>({});
  const [showRookieForm, setShowRookieForm] = useState(false);
  const [rkName, setRkName] = useState("");
  const [rkPos, setRkPos] = useState("");
  const [rkO, setRkO] = useState(-1.5);
  const [rkD, setRkD] = useState(-1.0);
  const [rkMin, setRkMin] = useState(15);

  function addRookie() {
    const name = rkName.trim();
    if (!name) return;
    const exists = players.find((p) => sameTeam(p.team, team) && normalizePlayerName(p.name) === normalizePlayerName(name));
    if (exists) {
      setNotes([`${exists.name} on jo joukkueessa ${team} — käytä hänen rivinsä "tulokas"-nappia.`]);
      return;
    }
    const id = `new:${Date.now()}`;
    setRookies((prev) => [...prev, { id, team, name, pos: rkPos.trim(), mpg_base: 0, oepm: rkO, depm: rkD, active: true }]);
    setMinutes((prev) => ({ ...prev, [id]: rkMin }));
    setRkName("");
    setRkPos("");
    setShowRookieForm(false);
  }

  const byId = useMemo(() => new Map(players.map((p) => [p.id, p])), [players]);
  const teamPlayers = useMemo(() => players.filter((p) => sameTeam(p.team, team)), [players, team]);

  function reset(newTeam?: string) {
    if (newTeam) {
      setTeam(newTeam);
      // Edellisen joukkueen liite pois, ettei sen siirrot päädy uudelle joukkueelle.
      setPaste("");
    }
    setDepartures({});
    setAdditions({});
    setMinutes({});
    setDestMinutes({});
    setRookies([]);
    setRookieMark({});
    setNotes([]);
    setStatus(null);
  }

  function findPlayer(name: string, preferTeam?: string, excludeTeam?: string): DbPlayer | null {
    const n = normalizePlayerName(name);
    const matches = players.filter((p) => normalizePlayerName(p.name) === n);
    if (matches.length === 0) return null;
    if (preferTeam) {
      const m = matches.find((p) => sameTeam(p.team, preferTeam));
      if (m) return m;
    }
    if (excludeTeam) {
      const m = matches.find((p) => !sameTeam(p.team, excludeTeam));
      if (m) return m;
    }
    return matches[0];
  }

  function applyPaste() {
    const { moves: allMoves, skipped, teams } = parseTeamTransactions(paste);
    const newDeps = { ...departures };
    const newAdds = { ...additions };
    const msgs: string[] = [];

    // Jos liitteessä on joukkueotsikoita, käytetään vain valitun joukkueen lohkoa.
    let moves = allMoves;
    if (teams.length > 0) {
      if (!teams.includes(team)) {
        setNotes([
          `Liitteessä on siirrot joukkueille ${teams.join(", ")}, ei joukkueelle ${team}. Valitse oikea joukkue tai liitä ${team}:n lista.`,
        ]);
        return;
      }
      moves = allMoves.filter((m) => m.team === team);
      if (teams.length > 1) {
        msgs.push(`Liitteessä oli ${teams.length} joukkuetta — käytettiin vain joukkueen ${team} siirrot.`);
      }
    } else {
      msgs.push(`Liitteessä ei ollut joukkueen nimeä otsikkona — varmista, että lista on joukkueen ${team}.`);
    }

    for (const mv of moves) {
      if (mv.kind === "resign") continue; // jatkosopimus: pelaaja pysyy, ei muutosta
      if (mv.kind === "departure") {
        const p = findPlayer(mv.name, team);
        if (!p || !sameTeam(p.team, team)) {
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
        if (sameTeam(p.team, team) || teamPlayers.some((x) => normalizePlayerName(x.name) === normalizePlayerName(p.name))) {
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
    // Jo tähän joukkueeseen tallennettu tulija näkyy rosterissa, ei toista kertaa tulijana.
    const incoming = Object.keys(additions)
      .map((id) => byId.get(id))
      .filter((p): p is DbPlayer => !!p && !sameTeam(p.team, team) && !staying.some((x) => x.id === p.id));
    return [...staying, ...incoming, ...rookies];
  }, [teamPlayers, departures, additions, byId, rookies]);
  const isRookie = (p: DbPlayer) => p.id.startsWith("new:") || !!rookieMark[p.id];

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
  const inMin =
    Object.keys(additions)
      .map((id) => byId.get(id))
      .filter((p): p is DbPlayer => !!p && p.active)
      .reduce((s, p) => s + minOf(p), 0) + rookies.reduce((s, p) => s + minOf(p), 0);
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
    const isNew = (p: DbPlayer) => p.id in additions || p.id.startsWith("new:");
    const staying = newRoster.filter((p) => p.active && !isNew(p));
    const incomingSum = newRoster.filter((p) => p.active && isNew(p)).reduce((s, p) => s + minOf(p), 0);
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
    // Tulokkaaksi merkityt kannassa jo olleet: joukkueen luvuissa ei ole heitä
    // lainkaan, joten koko vaikutus on muutosta (ei vain minuuttiero).
    let markO = 0;
    let markD = 0;
    for (const p of teamPlayers) {
      if (rookieMark[p.id] && !(p.id in departures)) {
        markO += p.oepm * (p.mpg_base / 48);
        markD += p.depm * (p.mpg_base / 48);
      }
    }
    return { o: newO - oldO + markO, d: newD - oldD + markD };
  }, [teamPlayers, newRoster, minutes, rookieMark, departures]);

  // Kesän muutos täsmälleen kuten Matchup laskee sen (rosteri − kauden 25-26 pohja,
  // skaalattu 240:een, liigakeskiarvo vähennetty) — luonnoksen muutokset mukana.
  const modelChange = useMemo(() => {
    if (prevRows.length === 0) return null;
    const hyp: DbPlayer[] = players.map((p) => {
      if (p.id in departures) return { ...p, team: departures[p.id], mpg_base: destMinOf(p, departures[p.id]) };
      if (p.id in additions) return { ...p, team, mpg_base: minOf(p) };
      if (sameTeam(p.team, team) && minutes[p.id] !== undefined) return { ...p, mpg_base: minutes[p.id] };
      return p;
    });
    for (const r of rookies) hyp.push({ ...r, mpg_base: minOf(r) });
    const { teams } = leagueNormalize(computeOffseason(hyp as any, prevRows));
    const t = Object.values(teams).find((x) => sameTeam(x.team, team));
    return t ? { o: t.offO, d: t.offD } : null;
  }, [players, departures, additions, minutes, destMinutes, rookies, prevRows, team]);
  // Pelaajan pohja TÄSSÄ joukkueessa (25-26 minuutit tässä joukkueessa / 82).
  function baseOnTeam(p: DbPlayer): number {
    return findPrev(p.name)
      .filter((r) => sameTeam(r.team, team))
      .reduce((a, r) => a + r.min_total / TEAM_GAMES, 0);
  }

  const searchResults = useMemo(() => {
    if (!search.trim()) return [];
    const q = normalizePlayerName(search);
    return players
      .filter((p) => !sameTeam(p.team, team) && !teamPlayers.some((x) => normalizePlayerName(x.name) === normalizePlayerName(p.name)) && !(p.id in additions) && normalizePlayerName(p.name).includes(q))
      .slice(0, 12);
  }, [search, players, team, additions, teamPlayers]);

  type Op = {
    playerId: string;
    newTeam: string;
    newMpg: number;
    label: string;
    // create = uusi pelaaja luodaan ensin; arrival = kirjataan vain tulo (ei lähtöä)
    create?: DbPlayer;
    arrival?: boolean;
  };
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
      if (!p || sameTeam(p.team, team)) continue; // jo tallennettu
      list.push({ playerId: id, newTeam: team, newMpg: minOf(p), label: `${p.name} ${p.team} → ${team} (${minOf(p)} min)` });
    }
    for (const r of rookies) {
      list.push({ playerId: r.id, newTeam: team, newMpg: minOf(r), label: `${r.name} (tulokas, uusi) → ${team} (${minOf(r)} min)`, create: r, arrival: true });
    }
    for (const p of teamPlayers) {
      if (p.id in departures) continue;
      if (rookieMark[p.id]) {
        list.push({ playerId: p.id, newTeam: team, newMpg: minOf(p), label: `${p.name} (tulokas) → ${team} (${minOf(p)} min)`, arrival: true });
        continue;
      }
      if (minutes[p.id] !== undefined && minutes[p.id] !== p.mpg_base) {
        list.push({ playerId: p.id, newTeam: team, newMpg: minutes[p.id], label: `${p.name} minuutit ${p.mpg_base} → ${minutes[p.id]}` });
      }
    }
    return list;
  }, [departures, additions, minutes, destMinutes, teamPlayers, team, byId, rookies, rookieMark]);

  async function save() {
    setSaving(true);
    setStatus(null);
    localStorage.setItem("cron_secret", secret);
    const failed: string[] = [];
    const doneIds = new Set<string>();
    for (const op of ops) {
      try {
        let playerId = op.playerId;
        if (op.create) {
          const cr = await fetch("/api/players/create", {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
            body: JSON.stringify({ team: op.newTeam, name: op.create.name, pos: op.create.pos, oepm: op.create.oepm, depm: op.create.depm }),
          });
          const cd = await cr.json().catch(() => ({}));
          if (!cr.ok || !cd.player?.id) {
            failed.push(`${op.label}: ${cd.error ?? cr.status}`);
            continue;
          }
          playerId = cd.player.id;
        }
        const res = await fetch("/api/transactions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ playerId, newTeam: op.newTeam, newMpg: op.newMpg, arrival: !!op.arrival }),
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          failed.push(`${op.label}: ${data.error ?? res.status}`);
        } else {
          doneIds.add(op.playerId);
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
      // Onnistuneet pois luonnoksesta, jotta niitä ei kirjata tai näytetä toiseen kertaan.
      const drop = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([id]) => !doneIds.has(id)));
      setAdditions((prev) => drop(prev));
      setDepartures((prev) => drop(prev));
      setMinutes((prev) => drop(prev));
      setDestMinutes((prev) => drop(prev));
      setRookieMark((prev) => drop(prev));
      setRookies((prev) => prev.filter((r) => !doneIds.has(r.id)));
      setStatus(`Virhe: ${failed.length}/${ops.length} epäonnistui (${ops.length - failed.length} tallennettu) — ${failed.join("; ")}`);
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
          {modelChange && (
            <div style={{ marginBottom: 2 }}>
              Kesän muutos (Matchup): Net{" "}
              <strong style={{ color: modelChange.o + modelChange.d >= 0 ? "#4ade80" : "#f87171" }}>{signed(modelChange.o + modelChange.d)}</strong>{" "}
              (O {signed(modelChange.o)} · D {signed(modelChange.d)}){" "}
              <span style={{ color: "#64748b" }}>— rosteri vs. kauden 25-26 pohja, liigakeskiarvo vähennetty</span>
            </div>
          )}
          Tämän luonnoksen muutos: O-EPM <strong style={{ color: impact.o >= 0 ? "#4ade80" : "#f87171" }}>{signed(impact.o)}</strong> · D-EPM{" "}
          <strong style={{ color: impact.d >= 0 ? "#4ade80" : "#f87171" }}>{signed(impact.d)}</strong>{" "}
          <span style={{ color: "#64748b" }}>(positiivinen D parantaa puolustusta)</span>
        </div>

        {teamPlayers.length > 0 && teamPlayers.filter((p) => p.active).reduce((x, p) => x + p.mpg_base, 0) === 0 && (
          <div style={{ fontSize: 12, color: "#fbbf24", background: "#422006", borderRadius: 6, padding: "8px 10px", marginBottom: 10 }}>
            Kaikilla joukkueen {team} pelaajilla on kannassa 0 minuuttia. Todennäköisesti joukkue on tuotu EPM-sivulta, jolla ei
            vielä ole tämän kauden minuutteja. Aseta minuutit tähän käsin ennen tallennusta, tai palauta lähtötilanne
            (Aloita alusta -laatikko).
          </div>
        )}

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
              <th style={{ padding: 4 }} title="(O+D) × (minuutit − pohja tässä joukkueessa) / 48">Muutos pohjaan</th>
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
                    {prevInfo(p) && <div style={{ fontSize: 10, color: "#64748b" }}>{prevInfo(p)}</div>}
                    {incoming && <span style={{ color: "#4ade80" }}> · tulee ({additions[p.id]})</span>}
                    {isRookie(p) && <span style={{ color: "#a78bfa" }}> · tulokas</span>}
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
                  {(() => {
                    const base = baseOnTeam(p);
                    const v = ((p.oepm + p.depm) * (m - base)) / 48;
                    return (
                      <td
                        style={{ padding: 4, color: Math.abs(v) < 0.005 ? "#64748b" : v > 0 ? "#4ade80" : "#f87171" }}
                        title={`pohja tässä joukkueessa ${base.toFixed(1)} min, nyt ${m} min`}
                      >
                        {Math.abs(v) < 0.005 ? "0.00" : signed(v)}
                      </td>
                    );
                  })()}
                  <td style={{ padding: 4, textAlign: "right" }}>
                    {p.id.startsWith("new:") ? (
                      <button
                        onClick={() => setRookies((prev) => prev.filter((r) => r.id !== p.id))}
                        style={{ ...inputBase, padding: "2px 8px", cursor: "pointer" }}
                      >
                        peru
                      </button>
                    ) : incoming ? (
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
                      <span style={{ display: "inline-flex", gap: 4 }}>
                      <button
                        onClick={() => setDepartures((prev) => ({ ...prev, [p.id]: FREE_AGENT }))}
                        style={{ ...inputBase, padding: "2px 8px", cursor: "pointer" }}
                      >
                        lähtee
                      </button>
                      </span>
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
          <button
            onClick={() => setShowRookieForm((v) => !v)}
            style={{ ...inputBase, padding: "6px 12px", marginLeft: 8, cursor: "pointer", color: "#a78bfa", borderColor: "#6d28d9" }}
          >
            + Lisää tulokas
          </button>
          {showRookieForm && (
            <div style={{ border: "1px solid #6d28d9", borderRadius: 8, padding: 10, marginTop: 8, maxWidth: 640 }}>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>
                Uusi pelaaja, jota ei vielä ole kannassa. Tallennus luo hänet joukkueeseen {team} ja kirjaa hänen vaikutuksensa
                (raaka EPM × minuutit / 48) joukkueen lukuihin.
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8, alignItems: "center" }}>
                <label style={{ fontSize: 11, color: "#94a3b8" }}>Varausnumero</label>
                <input
                  type="number"
                  min={1}
                  max={60}
                  placeholder="1–60"
                  onChange={(e) => {
                    const v = parseInt(e.target.value);
                    if (v >= 1) {
                      const r = rookieByPick(v);
                      setRkO(r.o);
                      setRkD(r.d);
                    }
                  }}
                  title="Asettaa O/D tulokaskauden arvion mukaan: O = 0.6 − 0.75·ln(varaus), D = −0.5 (2025 luokan data). 2. kierros / varaamaton: ~45–60."
                  style={{ ...inputBase, padding: "3px 6px", width: 56 }}
                />
                {ROOKIE_PRESETS.map((pr) => (
                  <button
                    key={pr.label}
                    onClick={() => {
                      setRkO(pr.o);
                      setRkD(pr.d);
                    }}
                    style={{ ...inputBase, padding: "3px 8px", cursor: "pointer" }}
                  >
                    {pr.label}
                  </button>
                ))}
              </div>
              <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
                <input value={rkName} onChange={(e) => setRkName(e.target.value)} placeholder="Nimi (kuten EPM-sivulla)" style={{ ...inputBase, padding: "5px 8px", width: 180 }} />
                <input value={rkPos} onChange={(e) => setRkPos(e.target.value)} placeholder="Pos" style={{ ...inputBase, padding: "5px 8px", width: 50 }} />
                <label style={{ fontSize: 11, color: "#94a3b8" }}>O</label>
                <input type="number" step="0.1" value={rkO} onChange={(e) => setRkO(parseFloat(e.target.value) || 0)} style={{ ...inputBase, padding: "5px 6px", width: 60 }} />
                <label style={{ fontSize: 11, color: "#94a3b8" }}>D</label>
                <input type="number" step="0.1" value={rkD} onChange={(e) => setRkD(parseFloat(e.target.value) || 0)} style={{ ...inputBase, padding: "5px 6px", width: 60 }} />
                <label style={{ fontSize: 11, color: "#94a3b8" }}>min</label>
                <input type="number" value={rkMin} onChange={(e) => setRkMin(parseFloat(e.target.value) || 0)} style={{ ...inputBase, padding: "5px 6px", width: 56 }} />
                <button
                  onClick={addRookie}
                  disabled={!rkName.trim()}
                  style={{ background: rkName.trim() ? "#6d28d9" : "#334155", color: "white", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: rkName.trim() ? "pointer" : "not-allowed" }}
                >
                  Lisää rosteriin
                </button>
              </div>
            </div>
          )}
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
