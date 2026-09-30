// Pelaajan O/D-arvio valitusta lähteestä: EPM, DARKO (O-DPM / D-DPM) tai niiden keskiarvo.
// Alkuperäiset EPM-luvut säilytetään kentissä epm_o / epm_d, ja oepm/depm korvataan
// valitulla arviolla — näin kaikki laskenta käyttää valittua lähdettä ilman muita muutoksia.
export type RatingSource = "epm" | "darko" | "avg";
export const RATING_LABEL: Record<RatingSource, string> = {
  avg: "Keskiarvo EPM + DARKO (suositus)",
  epm: "EPM",
  darko: "DARKO",
};

type P = { oepm: number; depm: number; epm_o?: number; epm_d?: number; darko_o?: number | null; darko_d?: number | null };

export function ratedOD(p: P, src: RatingSource): { o: number; d: number } {
  const eo = p.epm_o ?? p.oepm;
  const ed = p.epm_d ?? p.depm;
  const has = p.darko_o != null && p.darko_d != null && !Number.isNaN(Number(p.darko_o));
  if (src === "epm" || !has) return { o: eo, d: ed };
  const dO = Number(p.darko_o), dD = Number(p.darko_d);
  if (src === "darko") return { o: dO, d: dD };
  return { o: (eo + dO) / 2, d: (ed + dD) / 2 };
}

export function withRatings<T extends P>(players: T[], src: RatingSource): T[] {
  return players.map((p) => {
    const base = { ...p, epm_o: p.epm_o ?? Number(p.oepm) ?? 0, epm_d: p.epm_d ?? Number(p.depm) ?? 0 };
    const r = ratedOD(base, src);
    return { ...base, oepm: Math.round(r.o * 100) / 100, depm: Math.round(r.d * 100) / 100 };
  });
}

// DARKO:n leaderboard-CSV: Player, Team, ODPM, DDPM (merkit "+5.4" jne.)
export function parseDarkoCsv(raw: string): { rows: { name: string; team: string; o: number; d: number; mpg: number }[]; error?: string } {
  const lines = raw.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return { rows: [], error: "Tyhjä tiedosto." };
  const split = (l: string) => {
    const out: string[] = [];
    let cur = "", q = false;
    for (const ch of l) {
      if (ch === '"') q = !q;
      else if ((ch === "," || ch === "\t") && !q) {
        out.push(cur);
        cur = "";
      } else cur += ch;
    }
    out.push(cur);
    return out.map((x) => x.trim());
  };
  const h = split(lines[0]).map((x) => x.toLowerCase());
  const iP = h.indexOf("player"), iT = h.indexOf("team"), iO = h.indexOf("odpm"), iD = h.indexOf("ddpm"), iM = h.indexOf("mpg");
  if (iP < 0 || iO < 0 || iD < 0) return { rows: [], error: "Sarakkeita Player / ODPM / DDPM ei löytynyt." };
  const num = (s: string) => Number(String(s ?? "").replace("+", "").replace("−", "-").replace(",", "."));
  const rows = lines.slice(1).map((l) => {
    const c = split(l);
    return { name: c[iP], team: iT >= 0 ? c[iT] : "", o: num(c[iO]), d: num(c[iD]), mpg: iM >= 0 ? num(c[iM]) : 0 };
  }).filter((r) => r.name && Number.isFinite(r.o) && Number.isFinite(r.d));
  return { rows };
}
