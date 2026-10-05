"use client";

import { useEffect, useMemo, useState } from "react";
import { computePreseason, WINS_PER_NET, type PreSettings, type PreTeam } from "@/lib/preseason";
import { withRatings, type RatingSource } from "@/lib/ratings";
import type { PrevRow } from "@/lib/prevSeason";

type Snapshot = { date: string; nets: Record<RatingSource, Record<string, number>> };
const SOURCES: RatingSource[] = ["epm", "darko", "avg"];
const LABEL: Record<RatingSource, string> = { epm: "EPM", darko: "DARKO", avg: "Keskiarvo" };

function stats(pairs: { x: number; y: number }[]) {
  const n = pairs.length;
  if (n < 5) return null;
  const mx = pairs.reduce((a, p) => a + p.x, 0) / n;
  const my = pairs.reduce((a, p) => a + p.y, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (const p of pairs) {
    sxy += (p.x - mx) * (p.y - my);
    sxx += (p.x - mx) ** 2;
    syy += (p.y - my) ** 2;
  }
  const corr = sxy / Math.sqrt(sxx * syy);
  const k = sxy / sxx; // paras skaalaus: y ≈ k·x
  const rmse = Math.sqrt(pairs.reduce((a, p) => a + (p.y - my - (p.x - mx)) ** 2, 0) / n);
  const rmseScaled = Math.sqrt(pairs.reduce((a, p) => a + (p.y - my - k * (p.x - mx)) ** 2, 0) / n);
  return { n, corr, k, rmse, rmseScaled };
}

// Lähteiden (EPM / DARKO / keskiarvo) vertailu: markkinaan nyt, toteutuneeseen kauden edetessä.
export default function SourceCompare({
  teams,
  players,
  prevRows,
  settings,
  secret,
}: {
  teams: PreTeam[];
  players: any[];
  prevRows: PrevRow[];
  settings: PreSettings;
  secret: string;
}) {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [games, setGames] = useState<any[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((j) => j?.settings?.preseason_snapshot && setSnap(j.settings.preseason_snapshot))
      .catch(() => {});
    fetch("/api/schedule")
      .then((r) => r.json())
      .then((j) => setGames(j.games ?? []))
      .catch(() => {});
  }, []);

  const hasDarko = players.some((p) => p.darko_o != null);
  const now = useMemo(() => {
    if (teams.length < 20 || players.length === 0) return null;
    const out = {} as Record<RatingSource, Record<string, number>>;
    for (const src of SOURCES) {
      const pre = computePreseason(teams, withRatings(players, src), prevRows, { ...settings, marketWeight: 0 });
      out[src] = Object.fromEntries(Object.values(pre.byTeam).map((r) => [r.team, r.seasonNet]));
    }
    return out;
  }, [teams, players, prevRows, settings]);

  // Markkina: win totaleista johdettu Net
  const market = useMemo(() => {
    const m: Record<string, number> = {};
    for (const t of teams) if (t.win_total != null) m[t.team] = (Number(t.win_total) - 41) / WINS_PER_NET;
    return m;
  }, [teams]);

  // Toteutunut: pelattujen runkosarjaotteluiden keskimääräinen Net per joukkue
  const actual = useMemo(() => {
    const acc: Record<string, { s: number; n: number }> = {};
    for (const g of games) {
      if (g.season_type === "pre" || g.home_ortg == null || g.away_ortg == null) continue;
      for (const [t, net] of [
        [g.home, g.home_ortg - g.home_drtg],
        [g.away, g.away_ortg - g.away_drtg],
      ] as [string, number][]) {
        acc[t] ??= { s: 0, n: 0 };
        acc[t].s += net;
        acc[t].n += 1;
      }
    }
    return acc;
  }, [games]);
  const minGames = Object.values(actual).reduce((m, a) => Math.min(m, a.n), Infinity);

  async function saveSnapshot() {
    if (!now) return;
    const value: Snapshot = { date: new Date().toISOString().slice(0, 10), nets: now };
    const res = await fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
      body: JSON.stringify({ key: "preseason_snapshot", value }),
    });
    const j = await res.json().catch(() => ({}));
    if (res.ok) {
      setSnap(value);
      setMsg("Lähtötasot tallennettu — kauden edetessä niitä verrataan toteutuneeseen.");
    } else setMsg(`Virhe: ${j.error ?? res.status}`);
  }

  if (!now) return null;
  const td = { padding: "4px 10px", fontVariantNumeric: "tabular-nums" as const };
  const ref = snap?.nets ?? now;
  const rows = SOURCES.map((src) => {
    const vsMkt = stats(Object.keys(market).filter((t) => now[src][t] != null).map((t) => ({ x: now[src][t], y: market[t] })));
    const vsAct = stats(
      Object.keys(actual)
        .filter((t) => ref[src]?.[t] != null && actual[t].n > 0)
        .map((t) => ({ x: ref[src][t], y: actual[t].s / actual[t].n }))
    );
    return { src, vsMkt, vsAct };
  });
  const best = (key: "mkt" | "act") => {
    const vals = rows.map((r) => (key === "mkt" ? r.vsMkt?.rmseScaled : r.vsAct?.rmseScaled)).filter((x): x is number => x != null);
    return vals.length ? Math.min(...vals) : null;
  };

  return (
    <div style={{ border: "1px solid #334155", borderRadius: 8, padding: 14, margin: "8px 0 20px", maxWidth: 900 }}>
      <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Pelaaja-arvioiden vertailu: EPM vs DARKO vs keskiarvo</div>
      <div style={{ fontSize: 12, color: "#64748b", marginBottom: 10, lineHeight: 1.6 }}>
        Joukkueiden kauden alun Net lasketaan jokaisella lähteellä (sama rosteri, minuutit ja asetukset). <strong>Markkinaa vasten</strong> =
        kuinka lähellä win totaleista johdettua Netiä (saatavilla heti). <strong>Toteutunutta vasten</strong> = kuinka hyvin tallennettu
        lähtötaso ennusti pelattujen otteluiden Netin — luotettava noin 15–20 pelin jälkeen. Keskivirhe on laskettu parhaalla
        skaalauksella, joten se mittaa joukkueiden järjestystä ja erojen muotoa, ei tasoa.
        {!hasDarko && <span style={{ color: "#fbbf24" }}> DARKO-lukuja ei ole vielä tuotu (Players → DARKO) — DARKO ja keskiarvo ovat nyt samat kuin EPM.</span>}
      </div>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#94a3b8", textAlign: "left" }}>
            <th style={td}>Lähde</th>
            <th style={td}>Markkina: korrelaatio</th>
            <th style={td}>Markkina: keskivirhe (Net)</th>
            <th style={td}>Toteutunut: korrelaatio</th>
            <th style={td}>Toteutunut: keskivirhe (Net)</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.src} style={{ borderTop: "1px solid #1f2937" }}>
              <td style={{ ...td, fontWeight: 600 }}>{LABEL[r.src]}{settings.ratingSource === r.src ? " (käytössä)" : ""}</td>
              <td style={td}>{r.vsMkt ? r.vsMkt.corr.toFixed(3) : "—"}</td>
              <td style={{ ...td, color: r.vsMkt && r.vsMkt.rmseScaled === best("mkt") ? "#4ade80" : "#e2e8f0", fontWeight: r.vsMkt && r.vsMkt.rmseScaled === best("mkt") ? 700 : 400 }}>
                {r.vsMkt ? r.vsMkt.rmseScaled.toFixed(2) : "—"}
              </td>
              <td style={td}>{r.vsAct ? r.vsAct.corr.toFixed(3) : "—"}</td>
              <td style={{ ...td, color: r.vsAct && r.vsAct.rmseScaled === best("act") ? "#4ade80" : "#e2e8f0", fontWeight: r.vsAct && r.vsAct.rmseScaled === best("act") ? 700 : 400 }}>
                {r.vsAct ? r.vsAct.rmseScaled.toFixed(2) : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginTop: 10, fontSize: 12, color: "#94a3b8" }}>
        <span>
          {snap ? `Lähtötasot tallennettu ${snap.date}.` : "Lähtötasoja ei ole vielä tallennettu."}{" "}
          {Number.isFinite(minGames) ? `Pelattuja otteluita vähintään ${minGames} / joukkue.` : "Otteluita ei vielä pelattu."}
        </span>
        <button
          onClick={saveSnapshot}
          disabled={!secret}
          title="Tallentaa kaikkien kolmen lähteen kauden alun Netit, jotta niitä voi verrata toteutuneeseen, vaikka rosterit ja luvut muuttuvat kauden aikana. Tee tämä juuri ennen kauden alkua."
          style={{ background: "#1e293b", color: "#e2e8f0", border: "1px solid #334155", borderRadius: 6, padding: "4px 10px", fontSize: 12, cursor: "pointer" }}
        >
          {snap ? "Tallenna lähtötasot uudelleen" : "Tallenna lähtötasot"}
        </button>
        {msg && <span style={{ color: msg.startsWith("Virhe") ? "#f87171" : "#4ade80" }}>{msg}</span>}
      </div>
    </div>
  );
}
