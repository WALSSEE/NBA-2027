"use client";

import { useEffect, useMemo, useState } from "react";
import {
  parsePlayersPaste,
  parseEpmSitePaste,
  parseEpmLeaguePaste,
  type ParsedPlayer,
  type SiteParsedPlayer,
  type LeaguePlayer,
} from "@/lib/parsePlayers";
import { TEAM_NAME_BY_ABBR } from "@/lib/teamNames";

type DbPlayer = ParsedPlayer & { id: string; updated_at: string };

const ALL_TEAMS = Array.from(new Set(Object.values(TEAM_NAME_BY_ABBR))).sort();
const LEAGUE_ACCUMULATOR_KEY = "epm_league_accumulator_v1";

export default function PlayersPage() {
  const [tab, setTab] = useState<"excel" | "site" | "league">("excel");

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
        body: JSON.stringify({ mode: "team", team: siteTeam, players }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSiteStatus(`Virhe: ${data.error ?? "tuntematon virhe"}`);
      } else {
        setSiteStatus(`Tallennettu: ${siteTeam} päivitetty, ${data.count} pelaajaa.`);
        setSiteRaw("");
        setSitePreview([]);
        await loadCurrent();
      }
    } catch (e: any) {
      setSiteStatus(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setSiteSaving(false);
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
      </div>

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

      <h2 style={{ fontSize: 16, marginTop: 40, marginBottom: 8 }}>
        Nykyinen tietokannan rosteri ({current.length} pelaajaa)
      </h2>
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
