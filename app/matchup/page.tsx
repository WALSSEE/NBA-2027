"use client";

import { useEffect, useMemo, useState } from "react";
import { headshotUrl, initials, lastName, teamLogoUrl } from "@/lib/nbaAssets";
import { fairOdds, gameProbabilities, pct } from "@/lib/probability";
import { computeRosterChange, teamMinuteScale, canonTeam, type StartRow } from "@/lib/prevSeason";

type TeamStats = {
  id: string;
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

type Transaction = {
  id: string;
  team: string;
  date: string;
  delta_o: number | null;
  delta_d: number | null;
};

type Game = {
  id: string;
  date: string;
  home: string;
  away: string;
  home_ortg: number | null;
  home_drtg: number | null;
  home_pace: number | null;
  away_ortg: number | null;
  away_drtg: number | null;
  away_pace: number | null;
};

type DbPlayer = {
  id: string;
  team: string;
  name: string;
  pos: string;
  mpg_base: number;
  oepm: number;
  depm: number;
  active: boolean;
  nba_id: number | null;
  headshot_url?: string | null;
  out_since: string | null;
  out_until: string | null;
  gp_prev_season: number | null;
};

// out = poissa tässä ottelussa. embedded (E) = kuinka suuri osa pelaajan
// poissaolosta on "sisällä" joukkueen luvuissa (0–1). missed = tämän
// poissaolojakson aikana jo pelatut joukkueen ottelut. prevShare = viime
// kaudella missattujen pelien osuus.
type AbsenceInfo = { out: boolean; embedded: number; missed: number; prevShare: number };

const LEAGUE_AVG_PACE = 100;
const DEFAULT_BLEND = 100;
const BLEND_KEY = "matchup_blend_weight_v1";
const HOME_COLOR = "#60a5fa";
const AWAY_COLOR = "#f59e0b";
// Lopputuloksen hajonta mallin ennusteen ympärillä (pisteinä). Karkeat
// oletukset — säädettävissä sivun asetuksista.
const DEFAULT_MARGIN_SD = 12;
// Väsymys: pisteet jotka joukkueen marginaalista vähennetään.
// B2B = pelasi edellisenä päivänä. 3/4 = kolmas peli neljän päivän sisällä
// (kaksi peliä edeltävien 3 päivän aikana). Jos molemmat, vain B2B.
const DEFAULT_B2B = 2;
const DEFAULT_3IN4 = 1.5;
type Fatigue = "none" | "3in4" | "b2b";
const FATIGUE_LABEL: Record<Fatigue, string> = { none: "Levännyt", "3in4": "3 peliä / 4 pv", b2b: "B2B" };

// Ottelun tempo joukkueiden pacejen perusteella.
type PaceMethod = "excel" | "additive" | "average";
const PACE_LABEL: Record<PaceMethod, string> = {
  excel: "Excel: nopeampi 60 % + hitaampi 40 %",
  additive: "Additiivinen: koti + vieras − liiga",
  average: "Keskiarvo",
};
const PACE_KEY = "matchup_pace_method_v1";


function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}


const DEFAULT_TOTAL_SD = 18;

// EWMA-päivitys: uusi_rating = alpha * tuorein_peli + (1-alpha) * vanha_rating.
// Prior (kausiblendattu arvo) unohtuu itsestään pelien kertyessä.
function ewma(prior: number, values: number[], alpha: number): number {
  let rating = prior;
  for (const v of values) rating = alpha * v + (1 - alpha) * rating;
  return rating;
}

const rawBaseMin = (p: DbPlayer) => (p.active ? Number(p.mpg_base) || 0 : 0);

const POS_RANK: Record<string, number> = { PG: 1, G: 1.5, SG: 2, GF: 2.5, "G-F": 2.5, SF: 3, F: 3.5, PF: 4, "F-C": 4.5, FC: 4.5, C: 5 };
const posRank = (pos: string) => POS_RANK[(pos || "").toUpperCase().replace(/\s/g, "")] ?? 3;

// Viisikon paikat puolikenttäkuvassa (x %, y %), kori alhaalla.
const COURT_SLOTS = [
  { x: 50, y: 16 }, // PG
  { x: 84, y: 34 }, // SG
  { x: 16, y: 34 }, // SF
  { x: 28, y: 64 }, // PF
  { x: 66, y: 72 }, // C
];

function Avatar({ name, nbaId, url, size, ring, dim }: { name: string; nbaId: number | null; url?: string | null; size: number; ring?: string; dim?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = headshotUrl(nbaId, url);
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius: "50%",
        overflow: "hidden",
        flexShrink: 0,
        background: "#1e293b",
        border: ring ? `2px solid ${ring}` : "1px solid #334155",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        opacity: dim ? 0.4 : 1,
      }}
    >
      {src && !failed ? (
        <img
          src={src}
          alt={name}
          onError={() => setFailed(true)}
          style={{ width: "100%", height: "100%", objectFit: "cover", objectPosition: "center top" }}
        />
      ) : (
        <span style={{ fontSize: size * 0.36, fontWeight: 600, color: "#94a3b8" }}>{initials(name)}</span>
      )}
    </div>
  );
}

function TeamLogo({ team, size }: { team: string; size: number }) {
  const [failed, setFailed] = useState(false);
  const src = teamLogoUrl(team);
  if (!src || failed) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius: "50%",
          background: "#1e293b",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: size * 0.3,
          color: "#94a3b8",
          fontWeight: 700,
        }}
      >
        {initials(team)}
      </div>
    );
  }
  return <img src={src} alt={team} width={size} height={size} onError={() => setFailed(true)} style={{ objectFit: "contain" }} />;
}

function Court({ starters, color, onRemove }: { starters: DbPlayer[]; color: string; onRemove: (id: string) => void }) {
  const ordered = [...starters].sort((a, b) => posRank(a.pos) - posRank(b.pos));
  return (
    <div
      style={{
        position: "relative",
        width: "100%",
        aspectRatio: "100 / 94",
        background: "#132019",
        border: "1px solid #334155",
        borderRadius: 10,
        overflow: "hidden",
      }}
    >
      <svg viewBox="0 0 100 94" preserveAspectRatio="none" style={{ position: "absolute", inset: 0, width: "100%", height: "100%" }}>
        <g fill="none" stroke="#2f4a3a" strokeWidth="0.6">
          <rect x="1" y="1" width="98" height="92" />
          <rect x="34" y="56" width="32" height="37" />
          <circle cx="50" cy="56" r="12" />
          <path d="M 6 93 L 6 66 A 47.5 47.5 0 0 1 94 66 L 94 93" />
          <circle cx="50" cy="83.5" r="1.6" />
          <line x1="44" y1="86.5" x2="56" y2="86.5" />
          <path d="M 38 1 A 12 12 0 0 0 62 1" />
        </g>
      </svg>
      {ordered.slice(0, 5).map((p, i) => {
        const slot = COURT_SLOTS[i];
        return (
          <div
            key={p.id}
            onClick={() => onRemove(p.id)}
            title="Klikkaa poistaaksesi aloittajista"
            style={{
              position: "absolute",
              left: `${slot.x}%`,
              top: `${slot.y}%`,
              transform: "translate(-50%, -50%)",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              cursor: "pointer",
              width: 80,
            }}
          >
            <Avatar name={p.name} nbaId={p.nba_id} url={p.headshot_url} size={50} ring={color} />
            <div style={{ fontSize: 11, marginTop: 3, textAlign: "center", textShadow: "0 1px 2px #000", whiteSpace: "nowrap" }}>
              {lastName(p.name)}
            </div>
          </div>
        );
      })}
      {starters.length === 0 && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#64748b", fontSize: 12 }}>
          Ei aloittajia
        </div>
      )}
    </div>
  );
}

export default function MatchupPage() {
  const [teams, setTeams] = useState<TeamStats[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [games, setGames] = useState<Game[]>([]);
  const [players, setPlayers] = useState<DbPlayer[]>([]);
  // Alkutilanne (season_start_roster = Excelin rosterit ja minuutit). Tyhjä -> vanha siirtolokilaskenta.
  const [prevRows, setPrevRows] = useState<StartRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");

  // Kausiblendi: oletus 100 % 25-26, oma säätö muistetaan selaimessa.
  const [blendWeight, setBlendWeightState] = useState(DEFAULT_BLEND);
  const [alpha, setAlpha] = useState(0.15);
  const [marginSd, setMarginSd] = useState(DEFAULT_MARGIN_SD);
  const [totalSd, setTotalSd] = useState(DEFAULT_TOTAL_SD);

  // B2B: ottelupäivä (oletus tänään) -> tunnistetaan otteluohjelmasta,
  // pelasiko joukkue edellisenä päivänä. Käsin muutettavissa.
  const [gameDate, setGameDate] = useState("");
  const [b2bPenalty, setB2bPenalty] = useState(DEFAULT_B2B);
  const [threeInFourPenalty, setThreeInFourPenalty] = useState(DEFAULT_3IN4);
  // B2B:n vaikutus tempoon (possessioita per B2B-joukkue, esim. −0.5).
  const [b2bPaceAdj, setB2bPaceAdj] = useState(0);
  const [paceMethod, setPaceMethodState] = useState<PaceMethod>("excel");
  useEffect(() => {
    try {
      const v = localStorage.getItem(PACE_KEY);
      if (v === "excel" || v === "additive" || v === "average") setPaceMethodState(v);
    } catch {
      // ei haittaa
    }
  }, []);
  function setPaceMethod(v: PaceMethod) {
    setPaceMethodState(v);
    try {
      localStorage.setItem(PACE_KEY, v);
    } catch {
      // ei haittaa
    }
  }
  const [fatigueOverride, setFatigueOverride] = useState<Record<string, Fatigue>>({});
  useEffect(() => {
    const d = new Date();
    setGameDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }, []);

  // Vedonlyöntilinjat (kotijoukkueen tasoitus, over/under-raja).
  const [spreadLine, setSpreadLine] = useState("");
  const [totalLine, setTotalLine] = useState("");

  // Tämän ottelun kokoonpano: pelaajakohtaiset minuutit (ohittaa oletuksen)
  // ja valitut aloittajat per joukkue.
  const [gameMin, setGameMin] = useState<Record<string, number>>({});
  const [secret, setSecretState] = useState("");
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  useEffect(() => {
    try {
      setSecretState(localStorage.getItem("cron_secret") ?? "");
    } catch {
      // ei haittaa
    }
  }, []);
  function setSecret(v: string) {
    setSecretState(v);
    try {
      localStorage.setItem("cron_secret", v);
    } catch {
      // ei haittaa
    }
  }
  const [starterPick, setStarterPick] = useState<Record<string, string[]>>({});

  useEffect(() => {
    try {
      const v = localStorage.getItem(BLEND_KEY);
      if (v !== null && !Number.isNaN(Number(v))) setBlendWeightState(Number(v));
    } catch {
      // ei haittaa
    }
  }, []);
  function setBlendWeight(v: number) {
    setBlendWeightState(v);
    try {
      localStorage.setItem(BLEND_KEY, String(v));
    } catch {
      // ei haittaa
    }
  }

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [teamsRes, txRes, gamesRes, playersRes] = await Promise.all([
          fetch("/api/team-stats"),
          fetch("/api/transactions"),
          fetch("/api/schedule"),
          fetch("/api/players/import"),
        ]);
        const [teamsJson, txJson, gamesJson, playersJson] = await Promise.all([
          teamsRes.json(),
          txRes.json(),
          gamesRes.json(),
          playersRes.json(),
        ]);
        for (const j of [teamsJson, txJson, gamesJson, playersJson]) if (j.error) throw new Error(j.error);
        const t: TeamStats[] = teamsJson.teams ?? [];
        setTeams(t);
        setTransactions(txJson.transactions ?? []);
        setGames(gamesJson.games ?? []);
        setPlayers(
          (playersJson.players ?? []).map((p: any) => ({
            ...p,
            mpg_base: Number(p.mpg_base) || 0,
            oepm: Number(p.oepm) || 0,
            depm: Number(p.depm) || 0,
            nba_id: p.nba_id ? Number(p.nba_id) : null,
            out_since: p.out_since ?? null,
            out_until: p.out_until ?? null,
            gp_prev_season: p.gp_prev_season == null ? null : Number(p.gp_prev_season),
          }))
        );
        try {
          const pr = await fetch("/api/season-start").then((r) => r.json());
          setPrevRows((pr.rows ?? []).map((r: any) => ({ ...r, mpg: Number(r.mpg) || 0, oepm: Number(r.oepm) || 0, depm: Number(r.depm) || 0 })));
        } catch {
          setPrevRows([]);
        }
        if (t.length > 0) {
          setHomeTeam(t[0].team);
          setAwayTeam(t[1]?.team ?? t[0].team);
        }
      } catch (e: any) {
        setError(e.message ?? "Virhe datan haussa");
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  // --- Joukkueen taso (kausiblendi + EWMA + treidit), kuten ennenkin ---
  const gamesByTeam = useMemo(() => {
    const map: Record<string, { date: string; ortg: number; drtg: number; pace: number }[]> = {};
    for (const g of games) {
      if (g.home_ortg == null || g.away_ortg == null) continue;
      (map[g.home] ??= []).push({ date: g.date, ortg: g.home_ortg, drtg: g.home_drtg ?? 0, pace: g.home_pace ?? LEAGUE_AVG_PACE });
      (map[g.away] ??= []).push({ date: g.date, ortg: g.away_ortg, drtg: g.away_drtg ?? 0, pace: g.away_pace ?? LEAGUE_AVG_PACE });
    }
    return map;
  }, [games]);

  // Treidin delta vaimenee samaa tahtia kuin EWMA oppii saman asian peleistä.
  const usePrev = prevRows.length > 0;
  // Uudessa rakenteessa oletusminuutit ovat roolien painoja: joukkueen
  // aktiivisten minuutit skaalataan summaan 240 (sama kerroin kuin kesän muutoksessa).
  const minuteScale = useMemo(() => (usePrev ? teamMinuteScale(players) : {}), [usePrev, players]);
  const baseMin = (p: DbPlayer) => {
    const t = canonTeam(p.team);
    const k = t ? minuteScale[t] ?? 1 : 1;
    return Math.round(rawBaseMin(p) * k * 10) / 10;
  };
  const offseason = useMemo(() => (usePrev ? computeRosterChange(players, prevRows) : {}), [usePrev, players, prevRows]);
  // Kauden ensimmäinen ottelupäivä otteluohjelmasta. Sitä ennen kirjatut siirrot
  // ovat kesän siirtoja, jotka sisältyvät jo rosteripohjaiseen kesän muutokseen.
  const seasonStart = useMemo(() => games.reduce((m, g) => (g.date && g.date < m ? g.date : m), "9999-12-31"), [games]);

  function transactionNetFor(team: string) {
    const teamGames = gamesByTeam[team] ?? [];
    let o = 0;
    let d = 0;
    for (const tx of transactions) {
      if (tx.team !== team) continue;
      const decay = Math.pow(1 - alpha, teamGames.filter((g) => g.date >= tx.date).length);
      o += (Number(tx.delta_o) || 0) * decay;
      d += (Number(tx.delta_d) || 0) * decay;
    }
    return { o, d };
  }

  // Kokoonpanosäätö: tämän ottelun minuutit vs. oletusminuutit.
  // delta = raaka EPM × (ottelun min − oletus min) / 48.
  // --- Poissaolot ja tuplalaskennan korjaus ---
  // Joukkueen luvut sisältävät jo ne pelit, joissa pelaaja on puuttunut:
  //  - kauden alussa pohjana on viime kausi -> E0 = kausiblendin paino ×
  //    viime kaudella missattujen pelien osuus (esim. koko kauden missannut = 1)
  //  - jokainen tämän kauden peli päivittää E:tä samalla EWMA-painolla kuin
  //    joukkueen luvut: E = α × (1 jos poissa siinä pelissä, muuten 0) + (1 − α) × E
  // Korjaus = pelaajan vaikutus × (E − poissa nyt). Palannut pelaaja saa siis
  // lisäyksen, joka hiipuu pelien myötä; poissa oleva vähennyksen, joka hiipuu.
  const refDate = gameDate || "9999-12-31";
  function absenceOf(p: DbPlayer): AbsenceInfo {
    const t = teams.find((x) => x.team === p.team);
    const wEff = t?.coach_change ? 1 : blendWeight / 100;
    // Uudessa rakenteessa viime kauden poissaolot sisältyvät kesän muutokseen
    // (vaikutusminuutit), joten gp_prev_season käytetään vain vanhassa tilassa.
    const prevShare = usePrev || p.gp_prev_season == null ? 0 : Math.min(1, Math.max(0, 1 - p.gp_prev_season / 82));
    const inStint = (d: string) => !!p.out_since && d >= p.out_since && (!p.out_until || d < p.out_until);
    let e = wEff * prevShare;
    let missed = 0;
    for (const g of gamesByTeam[p.team] ?? []) {
      if (g.date >= refDate) break;
      const absent = inStint(g.date) ? 1 : 0;
      e = alpha * absent + (1 - alpha) * e;
      missed += absent;
    }
    const out = inStint(refDate);
    return { out, embedded: e, missed: out ? missed : 0, prevShare };
  }
  // Poissa tässä ottelussa, ellei minuutteja ole käsin asetettu.
  const effOut = (p: DbPlayer) => gameMin[p.id] === undefined && absenceOf(p).out;
  const minOf = (p: DbPlayer) => gameMin[p.id] ?? (effOut(p) ? 0 : baseMin(p));

  // Kokoonpanosäätö: tämän ottelun minuutit vs. oletusminuutit.
  // delta = raaka EPM × (ottelun min − oletus min) / 48, poissaoloille × (1 − E).
  // Muiden lisäminuutit (poissaolijan minuuttien jako) vaimenevat samassa
  // suhteessa kuin poissaolot keskimäärin. Pelaaville lisätään E × vaikutus.
  function lineupFor(team: string) {
    const roster = players.filter((p) => p.team === team);
    let outBase = 0;
    let outBaseW = 0;
    for (const p of roster) {
      if (effOut(p)) {
        const a = absenceOf(p);
        outBase += baseMin(p);
        outBaseW += baseMin(p) * (1 - a.embedded);
      }
    }
    const redistDecay = outBase > 0 ? outBaseW / outBase : 1;

    let o = 0;
    let d = 0;
    let total = 0;
    for (const p of roster) {
      const base = baseMin(p);
      const gm = minOf(p);
      const a = absenceOf(p);
      let w = 1;
      if (effOut(p)) w = 1 - a.embedded;
      else if (gm > base) w = redistDecay;
      o += ((p.oepm * (gm - base)) / 48) * w;
      d += ((p.depm * (gm - base)) / 48) * w;
      if (!effOut(p) && a.embedded > 0.001) {
        o += ((p.oepm * base) / 48) * a.embedded;
        d += ((p.depm * base) / 48) * a.embedded;
      }
      total += gm;
    }
    return { o, d, total, roster };
  }

  function finalStatsFor(team: TeamStats | undefined) {
    if (!team) return null;
    const w = team.coach_change ? 1 : blendWeight / 100;
    const mix = (a: number | null, b: number | null) => (a ?? b ?? LEAGUE_AVG_PACE) * w + (b ?? a ?? LEAGUE_AVG_PACE) * (1 - w);
    const ortgBlend = mix(team.ortg_2526, team.ortg_2425);
    const drtgBlend = mix(team.drtg_2526, team.drtg_2425);
    const paceBlend = mix(team.pace_2526, team.pace_2425);

    const played = gamesByTeam[team.team] ?? [];

    // Kesän muutos (rosteri nyt vs. viime kauden vaikutusminuutit) lisätään
    // lähtötasoon ennen EWMA:a, joten se hiipuu pelien myötä samaa tahtia kuin
    // viime kauden luvut.
    const off = usePrev ? offseason[team.team] : undefined;
    const offO = off?.offO ?? 0;
    const offD = off?.offD ?? 0;
    const ortgActual = ewma(ortgBlend + offO, played.map((g) => g.ortg), alpha);
    const drtgActual = ewma(drtgBlend - offD, played.map((g) => g.drtg), alpha);
    const paceActual = ewma(paceBlend, played.map((g) => g.pace), alpha);

    // Siirrot:
    //  - vanha tila (ei viime kauden minuutteja): kaikki siirrot, vaimennus pelien mukaan
    //  - uusi tila: vain kauden aikaiset siirrot. Ne ovat jo nykyisessä
    //    rosterissa (eli lähtötasossa painolla (1−α)^kaikki pelit), joten
    //    lisätään erotus niin, että paino on (1−α)^(pelit siirron jälkeen).
    let net = { o: 0, d: 0 };
    if (!usePrev) net = transactionNetFor(team.team);
    else {
      const before = played.filter((g) => g.date < refDate);
      const wAll = Math.pow(1 - alpha, before.length);
      for (const tx of transactions) {
        if (tx.team !== team.team || tx.date < seasonStart) continue;
        const wSince = Math.pow(1 - alpha, before.filter((g) => g.date >= tx.date).length);
        net.o += (Number(tx.delta_o) || 0) * (wSince - wAll);
        net.d += (Number(tx.delta_d) || 0) * (wSince - wAll);
      }
    }
    const modelOrtg = ortgActual + net.o;
    const modelDrtg = drtgActual - net.d;

    const lu = lineupFor(team.team);
    return {
      ortgBlend,
      drtgBlend,
      gamesPlayed: played.length,
      offO,
      offD,
      offUnmatched: off?.unmatched.length ?? 0,
      ortgActual,
      drtgActual,
      paceActual,
      netO: net.o,
      netD: net.d,
      modelOrtg,
      modelDrtg,
      lineupO: lu.o,
      lineupD: lu.d,
      lineupMin: lu.total,
      finalOrtg: modelOrtg + lu.o,
      finalDrtg: modelDrtg - lu.d,
    };
  }

  const home = teams.find((t) => t.team === homeTeam);
  const away = teams.find((t) => t.team === awayTeam);
  const homeFinal = finalStatsFor(home);
  const awayFinal = finalStatsFor(away);

  function fatigueAuto(team: string): Fatigue {
    if (!gameDate) return "none";
    const played = new Set(games.filter((g) => g.home === team || g.away === team).map((g) => g.date));
    if (played.has(addDays(gameDate, -1))) return "b2b";
    const last3 = [-1, -2, -3].filter((d) => played.has(addDays(gameDate, d))).length;
    return last3 >= 2 ? "3in4" : "none";
  }
  const fatigueOf = (team: string): Fatigue => fatigueOverride[team] ?? fatigueAuto(team);
  const fatiguePts = (f: Fatigue) => (f === "b2b" ? b2bPenalty : f === "3in4" ? threeInFourPenalty : 0);

  // Liigan keskitaso (ORTG = DRTG keskimäärin) samalla laskentatavalla kuin
  // joukkueet — tarvitaan pisteiden tasoon, marginaaliin se ei vaikuta.
  const leagueVals = teams.map((t) => finalStatsFor(t)).filter((f): f is NonNullable<typeof f> => !!f);
  const leagueAvg = leagueVals.length === 0 ? 114 : leagueVals.reduce((s, f) => s + (f.ortgActual + f.drtgActual) / 2, 0) / leagueVals.length;
  const leaguePace = leagueVals.length === 0 ? LEAGUE_AVG_PACE : leagueVals.reduce((s, f) => s + f.paceActual, 0) / leagueVals.length;

  function gamePace(h: number, a: number): number {
    if (paceMethod === "excel") return Math.max(h, a) * 0.6 + Math.min(h, a) * 0.4;
    if (paceMethod === "additive") return h + a - leaguePace;
    return (h + a) / 2;
  }

  // Sama logiikka kuin vanhassa Excel-laskurissa:
  //   marginaali = (koti NET − vieras NET) × poss/100 + HCA − koti B2B + vieras B2B
  // Pisteet: oma ORTG + vastustajan DRTG − liigan keskitaso (additiivinen
  // vastustajakorjaus), skaalattuna pacella.
  function project(hO: number, hD: number, aO: number, aD: number, pace: number, hca: number, hB2B: number, aB2B: number) {
    const homePts = (hO + aD - leagueAvg) * (pace / 100) + hca / 2 - hB2B / 2 + aB2B / 2;
    const awayPts = (aO + hD - leagueAvg) * (pace / 100) - hca / 2 + hB2B / 2 - aB2B / 2;
    return { homePts, awayPts, margin: homePts - awayPts, total: homePts + awayPts };
  }

  const projection = (() => {
    if (!home || !away || !homeFinal || !awayFinal) return null;
    const b2bCount = (fatigueOf(home.team) === "b2b" ? 1 : 0) + (fatigueOf(away.team) === "b2b" ? 1 : 0);
    const pace = gamePace(homeFinal.paceActual, awayFinal.paceActual) + b2bPaceAdj * b2bCount;
    const hca = home.home_adv ?? 0;
    const hB2B = fatiguePts(fatigueOf(home.team));
    const aB2B = fatiguePts(fatigueOf(away.team));
    const adj = project(homeFinal.finalOrtg, homeFinal.finalDrtg, awayFinal.finalOrtg, awayFinal.finalDrtg, pace, hca, hB2B, aB2B);
    const base = project(homeFinal.modelOrtg, homeFinal.modelDrtg, awayFinal.modelOrtg, awayFinal.modelDrtg, pace, hca, hB2B, aB2B);
    return { pace, hca, hB2B, aB2B, ...adj, base };
  })();

  const parsedSpread = spreadLine.trim() === "" ? null : Number(spreadLine.replace(",", "."));
  const parsedTotal = totalLine.trim() === "" ? null : Number(totalLine.replace(",", "."));
  const probs = projection
    ? gameProbabilities({
        margin: projection.margin,
        total: projection.total,
        marginSd,
        totalSd,
        spreadLine: parsedSpread != null && !Number.isNaN(parsedSpread) ? parsedSpread : null,
        totalLine: parsedTotal != null && !Number.isNaN(parsedTotal) ? parsedTotal : null,
      })
    : null;

  // --- Kokoonpanon muokkaus ---
  function startersFor(team: string, roster: DbPlayer[]): DbPlayer[] {
    const picked = starterPick[team];
    if (picked) return picked.map((id) => roster.find((p) => p.id === id)).filter((p): p is DbPlayer => !!p && minOf(p) > 0);
    return [...roster].filter((p) => minOf(p) > 0).sort((a, b) => minOf(b) - minOf(a)).slice(0, 5);
  }

  function toggleStarter(team: string, roster: DbPlayer[], id: string) {
    const current = startersFor(team, roster).map((p) => p.id);
    let next: string[];
    if (current.includes(id)) next = current.filter((x) => x !== id);
    else if (current.length < 5) next = [...current, id];
    else return;
    setStarterPick((prev) => ({ ...prev, [team]: next }));
  }

  function setMin(id: string, v: number) {
    setGameMin((prev) => ({ ...prev, [id]: Math.max(0, v) }));
  }

  // Poissaolon tallennus tietokantaan (OUT / IN), jotta pelimäärä poissaolon
  // alusta lasketaan automaattisesti otteluohjelmasta.
  async function saveAbsence(p: DbPlayer, patch: { out_since?: string | null; out_until?: string | null }) {
    if (!secret) {
      setStatusMsg("Poissaolon tallennus vaatii CRON_SECRETin — syötä se kohtaan Mallin asetukset.");
      return;
    }
    const body: Record<string, unknown> = { playerId: p.id };
    if ("out_since" in patch) body.outSince = patch.out_since;
    if ("out_until" in patch) body.outUntil = patch.out_until;
    try {
      const res = await fetch("/api/players/status", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
        body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatusMsg(`Virhe: ${data.error ?? res.status}`);
        return;
      }
      setPlayers((prev) => prev.map((x) => (x.id === p.id ? { ...x, ...patch } : x)));
      setGameMin((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
      setStatusMsg(null);
    } catch (e: any) {
      setStatusMsg(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    }
  }

  function toggleOut(p: DbPlayer) {
    const a = absenceOf(p);
    const date = gameDate || new Date().toISOString().slice(0, 10);
    if (!a.out && gameMin[p.id] === 0) {
      // pelkkä paikallinen 0 min -kokeilu -> palautetaan
      setGameMin((prev) => {
        const next = { ...prev };
        delete next[p.id];
        return next;
      });
      return;
    }
    if (a.out) {
      // Palaa. Jos poissaoloa ei ehditty pelata yhtään peliä, poistetaan kokonaan.
      if (a.missed === 0) saveAbsence(p, { out_since: null, out_until: null });
      else saveAbsence(p, { out_until: date });
    } else {
      saveAbsence(p, { out_since: date, out_until: null });
    }
  }

  // Skaalaa pelaavien (min > 0) minuutit summaan 240, max 40 min / pelaaja.
  function scaleTo240(roster: DbPlayer[]) {
    const CAP = 40;
    let remaining = roster.filter((p) => minOf(p) > 0);
    let tgt = 240;
    const result: Record<string, number> = {};
    for (let iter = 0; iter < 10 && remaining.length > 0; iter++) {
      const sum = remaining.reduce((s, p) => s + minOf(p), 0);
      const capped = remaining.filter((p) => (minOf(p) * tgt) / sum > CAP);
      if (capped.length === 0) {
        for (const p of remaining) result[p.id] = Math.round(((minOf(p) * tgt) / sum) * 10) / 10;
        break;
      }
      for (const p of capped) {
        result[p.id] = CAP;
        tgt -= CAP;
      }
      remaining = remaining.filter((p) => !capped.includes(p));
    }
    setGameMin((prev) => ({ ...prev, ...result }));
  }

  function resetLineup(team: string, roster: DbPlayer[]) {
    setGameMin((prev) => {
      const next = { ...prev };
      for (const p of roster) delete next[p.id];
      return next;
    });
    setStarterPick((prev) => {
      const next = { ...prev };
      delete next[team];
      return next;
    });
  }

  const missingPhotos = players.filter((p) => (p.team === homeTeam || p.team === awayTeam) && !p.nba_id && !p.headshot_url).length;

  const card = { background: "#111827", border: "1px solid #1f2937", borderRadius: 12 };
  const smallInput = {
    background: "#1e293b",
    color: "#e2e8f0",
    border: "1px solid #334155",
    borderRadius: 6,
    padding: "5px 8px",
    fontSize: 13,
  };
  const signed = (x: number, digits = 1) => `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;

  function TeamPanel({ teamName, color, isHome }: { teamName: string; color: string; isHome: boolean }) {
    const fin = isHome ? homeFinal : awayFinal;
    const lu = lineupFor(teamName);
    const roster = lu.roster;
    const starters = startersFor(teamName, roster);
    const starterIds = new Set(starters.map((p) => p.id));
    const sorted = [...roster].sort((a, b) => minOf(b) - minOf(a) || b.oepm + b.depm - (a.oepm + a.depm));
    const pts = projection ? (isHome ? projection.homePts : projection.awayPts) : null;
    const basePts = projection ? (isHome ? projection.base.homePts : projection.base.awayPts) : null;
    const lineupChanged = Math.abs(lu.o) + Math.abs(lu.d) > 0.005;
    const minColor = Math.abs(lu.total - 240) <= 5 ? "#4ade80" : Math.abs(lu.total - 240) <= 15 ? "#fbbf24" : "#f87171";

    return (
      <div style={{ ...card, padding: 16 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
          <TeamLogo team={teamName} size={28} />
          <div style={{ fontSize: 17, fontWeight: 600 }}>{teamName}</div>
          <span style={{ fontSize: 11, color: "#64748b" }}>{isHome ? "koti" : "vieras"}</span>
        </div>
        <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
          {basePts != null && <span>malli {basePts.toFixed(1)}</span>}
          {lineupChanged && pts != null && (
            <span style={{ color: "#f87171", fontWeight: 600 }}>
              kokoonpanolla {pts.toFixed(1)} (O {signed(fin?.lineupO ?? 0, 2)} / D {signed(fin?.lineupD ?? 0, 2)})
            </span>
          )}
          <span style={{ color: minColor }}>minuutit {lu.total.toFixed(0)}/240</span>
          <button onClick={() => scaleTo240(roster)} style={{ ...smallInput, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>
            Skaalaa 240:een
          </button>
          <button onClick={() => resetLineup(teamName, roster)} style={{ ...smallInput, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>
            Palauta
          </button>
        </div>

        <div style={{ display: "flex", flexWrap: "wrap", gap: 12 }}>
          <div style={{ flex: "1 1 220px", minWidth: 0 }}>
            <Court starters={starters} color={color} onRemove={(id) => toggleStarter(teamName, roster, id)} />
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 6 }}>
              Aloittajat: klikkaa pelaajaa kentällä poistaaksesi, tähteä listassa lisätäksesi. Malliin vaikuttavat vain
              minuutit.
            </div>
            {fin && (
              <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.6 }}>
                ORTG {fin.finalOrtg.toFixed(1)} · DRTG {fin.finalDrtg.toFixed(1)} · Pace {fin.paceActual.toFixed(1)}
              </div>
            )}
          </div>

          <div style={{ flex: "1.5 1 300px", minWidth: 0, border: "1px solid #1f2937", borderRadius: 10, padding: 8, maxHeight: 460, overflow: "auto" }}>
            <div style={{ fontSize: 11, color: "#64748b", padding: "0 4px 6px", display: "flex", justifyContent: "space-between" }}>
              <span>Rosteri</span>
              <span>EPM · min</span>
            </div>
            {sorted.map((p) => {
              const m = minOf(p);
              const absence = absenceOf(p);
              const zero = m === 0;
              const isStarter = starterIds.has(p.id);
              const changed = gameMin[p.id] !== undefined && gameMin[p.id] !== baseMin(p);
              const tot = p.oepm + p.depm;
              return (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    padding: "5px 4px",
                    borderTop: "1px solid #1f2937",
                    opacity: zero ? 0.45 : 1,
                  }}
                >
                  <button
                    onClick={() => toggleStarter(teamName, roster, p.id)}
                    disabled={zero || (!isStarter && starters.length >= 5)}
                    title={isStarter ? "Poista aloittajista" : "Lisää aloittajiin"}
                    style={{
                      background: "none",
                      border: "none",
                      cursor: "pointer",
                      color: isStarter ? color : "#334155",
                      fontSize: 14,
                      padding: 0,
                      width: 16,
                    }}
                  >
                    ★
                  </button>
                  <Avatar name={p.name} nbaId={p.nba_id} url={p.headshot_url} size={30} dim={zero} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{p.name}</div>
                    <div style={{ fontSize: 10, color: "#64748b" }}>
                      {p.pos || "—"} · {p.oepm.toFixed(1)}/{p.depm.toFixed(1)}
                      {changed && ` · oletus ${baseMin(p)}′`}
                    </div>
                    {effOut(p) && (
                      <div style={{ fontSize: 10, color: "#f87171", display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
                        poissa
                        <input
                          type="date"
                          value={p.out_since ?? ""}
                          onChange={(e) => e.target.value && saveAbsence(p, { out_since: e.target.value })}
                          title="Poissaolon alkupäivä — muuta, jos pelaaja on ollut poissa jo pidempään"
                          style={{ ...smallInput, padding: "0 3px", fontSize: 10, colorScheme: "dark" }}
                        />
                        alkaen · {absence.missed} peliä · vaikutus {Math.round((1 - absence.embedded) * 100)} %
                      </div>
                    )}
                    {!effOut(p) && absence.embedded > 0.01 && (
                      <div style={{ fontSize: 10, color: "#4ade80" }}>
                        {absence.prevShare > 0 ? `viime kausi ${p.gp_prev_season}/82 · ` : "palasi · "}paluuhyvitys{" "}
                        {Math.round(absence.embedded * 100)} %
                      </div>
                    )}
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: tot >= 0 ? "#4ade80" : "#f87171", width: 34, textAlign: "right" }}>
                    {signed(tot)}
                  </span>
                  <input
                    type="number"
                    value={m}
                    onChange={(e) => setMin(p.id, parseFloat(e.target.value) || 0)}
                    style={{
                      ...smallInput,
                      width: 50,
                      padding: "3px 5px",
                      fontSize: 12,
                      borderColor: changed ? color : "#334155",
                    }}
                  />
                  <button
                    onClick={() => toggleOut(p)}
                    title={zero ? "Palauta peliin" : "Merkitse poissa (loukkaantunut / lepää) — tallentuu, alkupäivä = ottelupäivä"}
                    style={{
                      ...smallInput,
                      padding: "2px 6px",
                      fontSize: 10,
                      width: 34,
                      cursor: "pointer",
                      color: zero ? "#4ade80" : "#f87171",
                    }}
                  >
                    {zero ? "IN" : "OUT"}
                  </button>
                </div>
              );
            })}
            {roster.length === 0 && <div style={{ fontSize: 12, color: "#64748b", padding: 8 }}>Ei pelaajia kannassa.</div>}
          </div>
        </div>
      </div>
    );
  }

  if (loading) {
    return <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>Ladataan...</div>;
  }

  const homeP = probs?.homeWin ?? 0.5;

  return (
    <div style={{ padding: "20px clamp(12px, 3vw, 20px)", fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      {error && <div style={{ color: "#f87171", marginBottom: 16, fontSize: 13 }}>Virhe: {error}</div>}
      {teams.length === 0 && !error && (
        <div style={{ color: "#f87171", fontSize: 13, marginBottom: 16 }}>team_stats-taulu on tyhjä — täytä Teams-sivu ensin.</div>
      )}

      {/* Valinnat */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        <select value={homeTeam} onChange={(e) => setHomeTeam(e.target.value)} style={{ ...smallInput, minWidth: 200 }}>
          {teams.map((t) => (
            <option key={t.team} value={t.team}>
              {t.team}
            </option>
          ))}
        </select>
        <span style={{ color: "#64748b", fontSize: 13 }}>vs</span>
        <select value={awayTeam} onChange={(e) => setAwayTeam(e.target.value)} style={{ ...smallInput, minWidth: 200 }}>
          {teams.map((t) => (
            <option key={t.team} value={t.team}>
              {t.team}
            </option>
          ))}
        </select>
        <button
          onClick={() => {
            setHomeTeam(awayTeam);
            setAwayTeam(homeTeam);
            setSpreadLine("");
          }}
          title="Vaihda koti ja vieras"
          style={{ ...smallInput, cursor: "pointer" }}
        >
          ⇄
        </button>
        <label style={{ fontSize: 12, color: "#94a3b8", marginLeft: 8 }}>Ottelupäivä</label>
        <input
          type="date"
          value={gameDate}
          onChange={(e) => {
            setGameDate(e.target.value);
            setFatigueOverride({});
          }}
          title="Väsymys tunnistetaan otteluohjelmasta: B2B = pelasi edellisenä päivänä, 3/4 = kaksi peliä edeltävien 3 päivän aikana"
          style={{ ...smallInput, colorScheme: "dark" }}
        />
      </div>

      {/* Ennuste + todennäköisyydet */}
      {projection && home && away && probs && (
        <div style={{ ...card, padding: "20px 20px 16px", marginBottom: 16 }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", alignItems: "center", gap: 16 }}>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <TeamLogo team={home.team} size={56} />
              <div style={{ fontWeight: 600, fontSize: "clamp(12px, 3.5vw, 16px)", textAlign: "center" }}>{home.team}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>koti{home.coach_change ? " · coach vaihtui" : ""}</div>
              <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <select
                  value={fatigueOf(home.team)}
                  onChange={(e) => setFatigueOverride((prev) => ({ ...prev, [home.team]: e.target.value as Fatigue }))}
                  style={{
                    ...smallInput,
                    padding: "2px 6px",
                    fontSize: 12,
                    color: fatigueOf(home.team) === "none" ? "#94a3b8" : "#f87171",
                  }}
                >
                  {(["none", "3in4", "b2b"] as Fatigue[]).map((f) => (
                    <option key={f} value={f}>
                      {FATIGUE_LABEL[f]}
                      {f === fatigueAuto(home.team) ? " (ohjelma)" : ""}
                    </option>
                  ))}
                </select>
                {fatiguePts(fatigueOf(home.team)) > 0 && (
                  <span style={{ color: "#f87171" }}>−{fatiguePts(fatigueOf(home.team))}</span>
                )}
              </div>
            </div>
            <div style={{ textAlign: "center" }}>
              <div style={{ fontSize: "clamp(22px, 6vw, 34px)", fontWeight: 700, fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
                {projection.homePts.toFixed(1)} – {projection.awayPts.toFixed(1)}
              </div>
              <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>
                Spread {home.team.split(" ").pop()} {projection.margin >= 0 ? "−" : "+"}
                {Math.abs(projection.margin).toFixed(1)} · Total {projection.total.toFixed(1)} · Pace {projection.pace.toFixed(1)}
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
              <TeamLogo team={away.team} size={56} />
              <div style={{ fontWeight: 600, fontSize: "clamp(12px, 3.5vw, 16px)", textAlign: "center" }}>{away.team}</div>
              <div style={{ fontSize: 12, color: "#64748b" }}>vieras{away.coach_change ? " · coach vaihtui" : ""}</div>
              <div style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 6 }}>
                <select
                  value={fatigueOf(away.team)}
                  onChange={(e) => setFatigueOverride((prev) => ({ ...prev, [away.team]: e.target.value as Fatigue }))}
                  style={{
                    ...smallInput,
                    padding: "2px 6px",
                    fontSize: 12,
                    color: fatigueOf(away.team) === "none" ? "#94a3b8" : "#f87171",
                  }}
                >
                  {(["none", "3in4", "b2b"] as Fatigue[]).map((f) => (
                    <option key={f} value={f}>
                      {FATIGUE_LABEL[f]}
                      {f === fatigueAuto(away.team) ? " (ohjelma)" : ""}
                    </option>
                  ))}
                </select>
                {fatiguePts(fatigueOf(away.team)) > 0 && (
                  <span style={{ color: "#f87171" }}>−{fatiguePts(fatigueOf(away.team))}</span>
                )}
              </div>
            </div>
          </div>

          {/* ML-palkki */}
          <div style={{ display: "flex", height: 30, borderRadius: 6, overflow: "hidden", marginTop: 18, fontSize: 13, fontWeight: 600 }}>
            <div style={{ width: `${homeP * 100}%`, background: HOME_COLOR, color: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 60 }}>
              {pct(probs.homeWin)}
            </div>
            <div style={{ flex: 1, background: AWAY_COLOR, color: "#0f172a", display: "flex", alignItems: "center", justifyContent: "center", minWidth: 60 }}>
              {pct(probs.awayWin)}
            </div>
          </div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 6 }}>
            Voittotodennäköisyys (ML, jatkoajat mukana). Reilut kertoimet: koti {fairOdds(probs.homeWin)} · vieras {fairOdds(probs.awayWin)}
          </div>

          {/* Linjat */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(280px, 100%), 1fr))", gap: 12, marginTop: 16 }}>
            <div style={{ background: "#0f172a", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Tasoitus</span>
                <span style={{ fontSize: 12, color: "#64748b" }}>{home.team.split(" ").pop()}</span>
                <input
                  value={spreadLine}
                  onChange={(e) => setSpreadLine(e.target.value)}
                  placeholder={`esim. ${projection.margin >= 0 ? "−" : "+"}${(Math.round(Math.abs(projection.margin) * 2) / 2).toFixed(1)}`}
                  inputMode="decimal"
                  style={{ ...smallInput, width: 90 }}
                />
              </div>
              {probs.homeCover != null ? (
                <div style={{ display: "flex", gap: "6px 16px", fontSize: 13, flexWrap: "wrap" }}>
                  <div>
                    <span style={{ color: HOME_COLOR }}>●</span> {home.team.split(" ").pop()} {parsedSpread! > 0 ? "+" : ""}
                    {parsedSpread}: <strong>{pct(probs.homeCover)}</strong>{" "}
                    <span style={{ color: "#64748b" }}>({fairOdds(probs.homeCover)})</span>
                  </div>
                  <div>
                    <span style={{ color: AWAY_COLOR }}>●</span> {away.team.split(" ").pop()} {-parsedSpread! > 0 ? "+" : ""}
                    {-parsedSpread!}: <strong>{pct(probs.awayCover)}</strong>{" "}
                    <span style={{ color: "#64748b" }}>({fairOdds(probs.awayCover)})</span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#64748b" }}>Syötä kotijoukkueen tasoitus (esim. −4.5 tai +3.5).</div>
              )}
            </div>
            <div style={{ background: "#0f172a", borderRadius: 8, padding: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 13, fontWeight: 600 }}>Over/Under</span>
                <input
                  value={totalLine}
                  onChange={(e) => setTotalLine(e.target.value)}
                  placeholder={`esim. ${(Math.round(projection.total * 2) / 2).toFixed(1)}`}
                  inputMode="decimal"
                  style={{ ...smallInput, width: 90 }}
                />
              </div>
              {probs.over != null ? (
                <div style={{ display: "flex", gap: "6px 16px", fontSize: 13, flexWrap: "wrap" }}>
                  <div>
                    Over {parsedTotal}: <strong>{pct(probs.over)}</strong> <span style={{ color: "#64748b" }}>({fairOdds(probs.over)})</span>
                  </div>
                  <div>
                    Under {parsedTotal}: <strong>{pct(probs.under)}</strong>{" "}
                    <span style={{ color: "#64748b" }}>({fairOdds(probs.under)})</span>
                  </div>
                </div>
              ) : (
                <div style={{ fontSize: 12, color: "#64748b" }}>Syötä total-linja (esim. 226.5).</div>
              )}
            </div>
          </div>
        </div>
      )}

      {statusMsg && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>{statusMsg}</div>}
      {!usePrev && !loading && (
        <div style={{ color: "#fbbf24", fontSize: 12, marginBottom: 12 }}>
          Alkutilannetta ei ole tallennettu — kesän muutokset lasketaan vanhalla tavalla siirtolokista. Aja
          supabase/setup_season_start.sql Supabasessa.
        </div>
      )}

      {missingPhotos > 0 && (
        <div style={{ fontSize: 12, color: "#64748b", marginBottom: 12 }}>
          {missingPhotos} pelaajalta puuttuu kuva. Hae ne Players-sivun napista &quot;Hae pelaajakuvat&quot;.
        </div>
      )}

      {/* Joukkuepaneelit */}
      {home && away && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(min(560px, 100%), 1fr))", gap: 16, marginBottom: 20 }}>
          {TeamPanel({ teamName: home.team, color: HOME_COLOR, isHome: true })}
          {TeamPanel({ teamName: away.team, color: AWAY_COLOR, isHome: false })}
        </div>
      )}

      {/* Asetukset ja erittely */}
      <details style={{ ...card, padding: 14, marginBottom: 12 }}>
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Mallin asetukset</summary>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 20, marginTop: 14 }}>
          <div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
              Kausiblendi — paino 25-26: {blendWeight} %
              {blendWeight !== DEFAULT_BLEND && (
                <button onClick={() => setBlendWeight(DEFAULT_BLEND)} style={{ ...smallInput, marginLeft: 8, padding: "1px 8px", fontSize: 11, cursor: "pointer" }}>
                  Palauta 100 %
                </button>
              )}
            </label>
            <input type="range" min={0} max={100} value={blendWeight} onChange={(e) => setBlendWeight(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: "#64748b" }}>Muistetaan tässä selaimessa. &quot;Coach vaihtui&quot; -joukkueet käyttävät aina vain 25-26.</div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
              Pelattujen otteluiden paino (α): {alpha.toFixed(2)} (~{Math.round(1 / alpha)} pelin muisti)
            </label>
            <input type="range" min={0.05} max={0.5} step={0.01} value={alpha} onChange={(e) => setAlpha(Number(e.target.value))} style={{ width: "100%" }} />
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>CRON_SECRET (poissaolojen tallennus)</label>
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ ...smallInput, width: 160, marginBottom: 12 }} />
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Tempokaava</label>
            <select value={paceMethod} onChange={(e) => setPaceMethod(e.target.value as PaceMethod)} style={{ ...smallInput, width: "100%", marginBottom: 4 }}>
              {(Object.keys(PACE_LABEL) as PaceMethod[]).map((m) => (
                <option key={m} value={m}>
                  {PACE_LABEL[m]}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              Liigan keskipace {leaguePace.toFixed(1)}. Additiivinen nopeuttaa kahden nopean ja hidastaa kahden hitaan joukkueen ottelua.
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>B2B:n tempovaikutus (poss / B2B-joukkue)</label>
            <input type="number" step="0.25" value={b2bPaceAdj} onChange={(e) => setB2bPaceAdj(parseFloat(e.target.value) || 0)} style={{ ...smallInput, width: 70, marginBottom: 12 }} />
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Väsymysvähennys: B2B / 3 peliä 4 pv (pistettä)</label>
            <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
              <input type="number" step="0.5" value={b2bPenalty} onChange={(e) => setB2bPenalty(parseFloat(e.target.value) || 0)} style={{ ...smallInput, width: 70 }} />
              <input type="number" step="0.5" value={threeInFourPenalty} onChange={(e) => setThreeInFourPenalty(parseFloat(e.target.value) || 0)} style={{ ...smallInput, width: 70 }} />
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Hajonta: marginaali / total (pistettä)</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input type="number" step="0.5" value={marginSd} onChange={(e) => setMarginSd(Math.max(1, parseFloat(e.target.value) || DEFAULT_MARGIN_SD))} style={{ ...smallInput, width: 70 }} />
              <input type="number" step="0.5" value={totalSd} onChange={(e) => setTotalSd(Math.max(1, parseFloat(e.target.value) || DEFAULT_TOTAL_SD))} style={{ ...smallInput, width: 70 }} />
            </div>
            <div style={{ fontSize: 11, color: "#64748b", marginTop: 4 }}>
              Kuinka paljon toteutunut tulos heittelee ennusteen ympärillä. Karkeat oletukset {DEFAULT_MARGIN_SD} / {DEFAULT_TOTAL_SD}; isompi arvo = todennäköisyydet lähempänä 50 %:a.
            </div>
          </div>
        </div>
      </details>

      {homeFinal && awayFinal && home && away && (
        <details style={{ ...card, padding: 14 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Laskennan erittely</summary>
          <div style={{ overflowX: "auto", marginTop: 12 }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                  {["Joukkue", "Kausiblendi O/D", "Kesän muutos O/D", "Pelattu", "EWMA O/D", usePrev ? "Kauden siirrot O/D" : "Siirrot O/D", "Kokoonpano O/D", "Final ORTG", "Final DRTG", "Pace", "HCA"].map((h) => (
                    <th key={h} style={{ padding: 6 }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[
                  { t: home, f: homeFinal },
                  { t: away, f: awayFinal },
                ].map(({ t, f }) => (
                  <tr key={t.team} style={{ borderTop: "1px solid #334155" }}>
                    <td style={{ padding: 6 }}>{t.team}</td>
                    <td style={{ padding: 6, color: "#64748b" }}>
                      {f.ortgBlend.toFixed(1)} / {f.drtgBlend.toFixed(1)}
                    </td>
                    <td style={{ padding: 6 }}>
                      {usePrev ? `${signed(f.offO, 2)} / ${signed(f.offD, 2)}` : "—"}
                      {f.offUnmatched > 0 && <span style={{ color: "#fbbf24" }}> ({f.offUnmatched} EPM puuttuu)</span>}
                    </td>
                    <td style={{ padding: 6 }}>{f.gamesPlayed}</td>
                    <td style={{ padding: 6 }}>
                      {f.ortgActual.toFixed(1)} / {f.drtgActual.toFixed(1)}
                    </td>
                    <td style={{ padding: 6 }}>
                      {signed(f.netO, 2)} / {signed(f.netD, 2)}
                    </td>
                    <td style={{ padding: 6 }}>
                      {signed(f.lineupO, 2)} / {signed(f.lineupD, 2)}
                    </td>
                    <td style={{ padding: 6, fontWeight: 700 }}>{f.finalOrtg.toFixed(1)}</td>
                    <td style={{ padding: 6, fontWeight: 700 }}>{f.finalDrtg.toFixed(1)}</td>
                    <td style={{ padding: 6 }}>{f.paceActual.toFixed(1)}</td>
                    <td style={{ padding: 6 }}>{t.home_adv ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize: 11, color: "#64748b", maxWidth: 760, marginTop: 10, lineHeight: 1.6 }}>
            {usePrev
              ? "Kesän muutos = Σ nykyinen rosteri (EPM × oletusmin / 48) − Σ alkutilanne (Excelin rosterit ja minuutit, EPM × min / 48); molemmat skaalattu 240 minuuttiin. Alkutilanteessa muutos on tasan 0. Se lisätään lähtötasoon ennen EWMA:a, joten se hiipuu pelien myötä. Kauden aikaiset siirrot painotetaan (1−α)^(pelit siirron jälkeen). "
              : "Alkutilannetta ei ole tallennettu (setup_season_start.sql), joten käytetään siirtolokia: "}
            Final ORTG = EWMA ORTG + siirtojen O-delta + kokoonpanon O-delta. Final DRTG =
            EWMA DRTG − treidien D-delta − kokoonpanon D-delta. Kokoonpanon delta = raaka EPM × (tämän ottelun min − oletus min) / 48:
            poissa oleva pelaaja jonka minuutteja ei jaeta muille korvautuu siis liigan keskitason (0 EPM) pelaajalla. Tuplalaskennan
            korjaus: poissaolon vaikutus × (1−α)^(pelit jotka pelaaja on jo ollut poissa), koska EWMA on jo oppinut ne pelit; muiden
            lisäminuutit vaimenevat samassa suhteessa. Palanneelle lisätään takaisin se osa poissaolosta, joka on vielä joukkueen
            luvuissa: (1 − (1−α)^poissa-pelit) × (1−α)^paluun jälkeiset pelit. Marginaali =
            (koti NET − vieras NET) × (pace / 100) + HCA − koti väsymys + vieras väsymys (B2B {b2bPenalty} p, 3 peliä / 4 pv {threeInFourPenalty} p, ei yhteenlaskua). Pisteet =
            (oma ORTG + vastustajan DRTG − liigan keskitaso {leagueAvg.toFixed(1)}) × (pace / 100) ± HCA/2 ∓ väsymys/2. Todennäköisyydet olettavat, että marginaali ja
            yhteispisteet jakautuvat normaalisti ennusteen ympärille yllä asetetulla hajonnalla.
          </div>
        </details>
      )}
    </div>
  );
}
