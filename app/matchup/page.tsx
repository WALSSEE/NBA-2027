"use client";

import { useEffect, useMemo, useState } from "react";
import { headshotUrl, initials, lastName, teamLogoUrl } from "@/lib/nbaAssets";
import { fairOdds, gameProbabilities, normCdf, pct } from "@/lib/probability";
import { consensus, bestPrice, usGameDate, type OddsEvent, type BookLines } from "@/lib/odds";
import { teamMinuteScale, canonTeam, type PrevRow } from "@/lib/prevSeason";
import { computePreseason, calibrateCarry, WINS_PER_NET } from "@/lib/preseason";
import { REPL_O, REPL_D } from "@/lib/availability";
import { withRatings, RATING_LABEL, type RatingSource } from "@/lib/ratings";

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
  win_total?: number | null;
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
const DEFAULT_ALPHA = 0.05;
// Kauden alun regressio: viime kauden luvuista säilyy vain osa (NBA 2024-25 -> 2025-26:
// Net ~54 %, tempo ~50 %). Rosterimuutokset lasketaan erikseen, joten oletus 70 %.
// Joukkueen viime kauden luku jaetaan kahteen osaan:
//  - pelaajista selittyvä osa (Σ EPM × pohjaminuutit / 48) — kulkee pelaajien mukana
//    rosterimuutoksissa; säilyy lähes kokonaan
//  - jäännös (luku − selittyvä osa): tuuri, valmennus, tankkaus, EPM:n virhe — pysyy
//    joukkueella, joten se regressoidaan voimakkaasti (2025-26: Hornets +5.0, Heat +6.3,
//    Pacers −4.1 ...)
const DEFAULT_CARRY = { player: 85, res: 50, pace: 50 };
const CARRY_KEY = "matchup_carry_v2";
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

// Pelipaikka: normaali kotipeli, harjoituspelin kotipeli (pienempi kotietu)
// tai neutraali kenttä (kotietu 0). "auto" = harjoituspeli jos ottelu on
// otteluohjelmassa harjoituspelinä, muuten normaali.
type Venue = "auto" | "normal" | "pre" | "neutral";
const VENUE_LABEL: Record<Exclude<Venue, "auto">, string> = {
  normal: "Kotipeli",
  pre: "Harjoituspeli (koti)",
  neutral: "Neutraali kenttä",
};
const DEFAULT_PRE_HCA_FACTOR = 0.5;
const PRE_HCA_KEY = "matchup_pre_hca_factor_v1";
const VENUE_KEY = "matchup_venue_override_v1";
const PRE_TOTAL_KEY = "matchup_pre_total_shift_v1";

// Ottelun tempo joukkueiden pacejen perusteella.
type PaceMethod = "excel" | "additive" | "average";
const PACE_LABEL: Record<PaceMethod, string> = {
  additive: "Additiivinen: koti + vieras − liiga (suositus)",
  excel: "Excel: nopeampi 60 % + hitaampi 40 %",
  average: "Keskiarvo",
};
// v2: oletus vaihdettu additiiviseen (regressio 2024-26, 2460 ottelua).
const PACE_KEY = "matchup_pace_method_v2";
const PACE_ALPHA_KEY = "matchup_pace_alpha_v1";
const DEFAULT_PACE_ALPHA = 0.08;
const DEFAULT_B2B_PACE = -0.45;


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
  // Kauden 25-26 pelatut minuutit (prev_season_minutes) = pohja, josta joukkueiden
  // 25-26 luvut syntyivät. Tyhjä -> vanha siirtolokilaskenta.
  const [prevRows, setPrevRows] = useState<PrevRow[]>([]);
  // Liigatason korjaus: kesän muutosten liigakeskiarvo vähennetään (Net-summa on aina 0).
  const [leagueNorm, setLeagueNormState] = useState(true);
  // Odotetut poissaolot kauden keskitasoon (win total -vertailu, Teams, Kausi). Pois = vanha tapa.
  const [injuryAdj, setInjuryAdj] = useState(true);
  useEffect(() => {
    try {
      if (localStorage.getItem("matchup_league_norm_v1") === "0") setLeagueNormState(false);
    } catch {
      // ei haittaa
    }
  }, []);
  function setLeagueNorm(v: boolean) {
    setLeagueNormState(v);
    try {
      localStorage.setItem("matchup_league_norm_v1", v ? "1" : "0");
    } catch {
      // ei haittaa
    }
  }
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [homeTeam, setHomeTeam] = useState("");
  const [awayTeam, setAwayTeam] = useState("");

  // Kausiblendi: oletus 100 % 25-26, oma säätö muistetaan selaimessa.
  const [blendWeight, setBlendWeightState] = useState(DEFAULT_BLEND);
  const [carry, setCarryState] = useState(DEFAULT_CARRY);
  // Pelaaja-arvioiden lähde: EPM / DARKO / keskiarvo (tallennetaan mallin asetuksiin).
  const [ratingSource, setRatingSource] = useState<RatingSource>("avg");
  // Kauden alun tempotason korjaus (poss): lisätään jokaisen joukkueen lähtötempoon,
  // hiipuu EWMA:n myötä. Kauden alussa tempo on ollut ~1.2–1.5 poss kauden keskiarvoa
  // korkeampi (2024-25 ja 2025-26), ja liigan pisteet ovat nousseet kausi kaudelta.
  const [paceShift, setPaceShiftState] = useState(0);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem("matchup_pace_shift_v1"));
      if (Number.isFinite(v) && Math.abs(v) <= 10) setPaceShiftState(v);
    } catch {
      // ei haittaa
    }
  }, []);
  function setPaceShift(v: number) {
    const r = Math.round(v * 10) / 10;
    setPaceShiftState(r);
    try {
      localStorage.setItem("matchup_pace_shift_v1", String(r));
    } catch {
      // ei haittaa
    }
  }
  // Win totalien paino kauden alun lähtötasossa (0 = vain vertailu).
  const [marketWeight, setMarketWeightState] = useState(0);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem("matchup_market_weight_v1"));
      if (v >= 0 && v <= 100) setMarketWeightState(v);
    } catch {
      // ei haittaa
    }
  }, []);
  function setMarketWeight(v: number) {
    setMarketWeightState(v);
    try {
      localStorage.setItem("matchup_market_weight_v1", String(v));
    } catch {
      // ei haittaa
    }
  }
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(CARRY_KEY) ?? "null");
      if (v && typeof v.player === "number" && typeof v.res === "number" && typeof v.pace === "number") setCarryState(v);
    } catch {
      // ei haittaa
    }
  }, []);
  function setCarry(v: typeof DEFAULT_CARRY) {
    setCarryState(v);
    try {
      localStorage.setItem(CARRY_KEY, JSON.stringify(v));
    } catch {
      // ei haittaa
    }
  }
  // Ratingien EWMA-α: 0.05 (~20 pelin muisti) oli paras 2024-26 backtestissä sekä tasoitukselle
  // että totalille; 0.15 ylireagoi yksittäisiin peleihin (totalit liian matalia heikoille hyökkäyksille).
  const [alpha, setAlpha] = useState(DEFAULT_ALPHA);
  const [marginSd, setMarginSd] = useState(DEFAULT_MARGIN_SD);
  const [totalSd, setTotalSd] = useState(DEFAULT_TOTAL_SD);

  // B2B: ottelupäivä (oletus tänään) -> tunnistetaan otteluohjelmasta,
  // pelasiko joukkue edellisenä päivänä. Käsin muutettavissa.
  const [gameDate, setGameDate] = useState("");
  const [b2bPenalty, setB2bPenalty] = useState(DEFAULT_B2B);
  const [threeInFourPenalty, setThreeInFourPenalty] = useState(DEFAULT_3IN4);
  // B2B:n vaikutus tempoon (possessioita per B2B-joukkue, esim. −0.5).
  const [b2bPaceAdj, setB2bPaceAdj] = useState(DEFAULT_B2B_PACE);
  const [paceMethod, setPaceMethodState] = useState<PaceMethod>("additive");
  // Tempolle oma α: tempo on joukkueen ominaisuutena vakaampi kuin ORTG/DRTG.
  const [paceAlpha, setPaceAlphaState] = useState(DEFAULT_PACE_ALPHA);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(PACE_ALPHA_KEY));
      if (v >= 0.02 && v <= 0.5) setPaceAlphaState(v);
    } catch {
      // ei haittaa
    }
  }, []);
  function setPaceAlpha(v: number) {
    setPaceAlphaState(v);
    try {
      localStorage.setItem(PACE_ALPHA_KEY, String(v));
    } catch {
      // ei haittaa
    }
  }
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
  // Pelipaikka per ottelu (avain päivä|koti|vieras), tallennetaan selaimeen.
  const [venueOverride, setVenueOverrideState] = useState<Record<string, Venue>>({});
  const [preHcaFactor, setPreHcaFactorState] = useState(DEFAULT_PRE_HCA_FACTOR);
  useEffect(() => {
    try {
      const v = JSON.parse(localStorage.getItem(VENUE_KEY) ?? "null");
      if (v && typeof v === "object") setVenueOverrideState(v);
      const f = Number(localStorage.getItem(PRE_HCA_KEY));
      if (localStorage.getItem(PRE_HCA_KEY) != null && Number.isFinite(f) && f >= 0 && f <= 1.5) setPreHcaFactorState(f);
    } catch {
      // ei haittaa
    }
  }, []);
  function setVenueFor(key: string, v: Venue) {
    setVenueOverrideState((prev) => {
      const next = { ...prev };
      if (v === "auto") delete next[key];
      else next[key] = v;
      try {
        localStorage.setItem(VENUE_KEY, JSON.stringify(next));
      } catch {
        // ei haittaa
      }
      return next;
    });
  }
  // Harjoituspelien total-korjaus (pistettä per peli, molemmille joukkueille puolet).
  const [preTotalShift, setPreTotalShiftState] = useState(0);
  useEffect(() => {
    try {
      const v = Number(localStorage.getItem(PRE_TOTAL_KEY));
      if (localStorage.getItem(PRE_TOTAL_KEY) != null && Number.isFinite(v)) setPreTotalShiftState(v);
    } catch {
      // ei haittaa
    }
  }, []);
  function setPreTotalShift(v: number) {
    if (!Number.isFinite(v)) return;
    const c = Math.max(-30, Math.min(30, Math.round(v * 10) / 10));
    setPreTotalShiftState(c);
    try {
      localStorage.setItem(PRE_TOTAL_KEY, String(c));
    } catch {
      // ei haittaa
    }
  }
  type HistSum = { n: number; total: number | null; pace: number | null; nHome: number; nNeutral: number; homeMargin: number | null; homeMarginSe: number | null };
  const [preHist, setPreHist] = useState<{ season: number; pre: HistSum; reg: HistSum }[] | null>(null);
  const [preHistMsg, setPreHistMsg] = useState<string | null>(null);
  async function loadPreHist() {
    const y = Number(gameDate.slice(0, 4)) || new Date().getFullYear();
    // Viimeiset kolme päättynyttä harjoituskautta (kuluva kausi mukaan, jos se on jo ohi).
    const seasons = [y - 3, y - 2, y - 1];
    setPreHist(null);
    const got: { season: number; pre: HistSum; reg: HistSum }[] = [];
    for (const s of seasons) {
      setPreHistMsg(`Haetaan kautta ${s}-${String(s + 1).slice(2)} ESPN:stä...`);
      try {
        const r = await fetch(`/api/preseason-history?seasons=${s}`);
        const j = await r.json();
        if (!r.ok || j.error) throw new Error(j.error ?? `HTTP ${r.status}`);
        got.push(...j.seasons);
      } catch (e: any) {
        setPreHistMsg(`Virhe kaudella ${s}: ${e?.message ?? e}`);
        if (got.length) setPreHist(got);
        return;
      }
    }
    setPreHist(got);
    setPreHistMsg(null);
  }
  const preHistSummary = (() => {
    if (!preHist) return null;
    const ok = preHist.filter((b) => b.pre.n >= 10 && b.reg.n >= 10 && b.pre.total != null && b.reg.total != null);
    if (!ok.length) return null;
    const mean = (xs: (number | null)[]) => {
      const v = xs.filter((x): x is number => x != null);
      return v.length ? v.reduce((a, x) => a + x, 0) / v.length : null;
    };
    const preHomeN = ok.reduce((a, b) => a + b.pre.nHome, 0);
    const regHomeN = ok.reduce((a, b) => a + b.reg.nHome, 0);
    const wMean = (f: (b: (typeof ok)[number]) => number | null, w: (b: (typeof ok)[number]) => number, N: number) =>
      N > 0 ? ok.reduce((a, b) => a + (f(b) ?? 0) * w(b), 0) / N : null;
    return {
      nSeasons: ok.length,
      totalDiff: mean(ok.map((b) => b.pre.total! - b.reg.total!)),
      paceDiff: mean(ok.map((b) => (b.pre.pace != null && b.reg.pace != null ? b.pre.pace - b.reg.pace : null))),
      preHome: wMean((b) => b.pre.homeMargin, (b) => b.pre.nHome, preHomeN),
      regHome: wMean((b) => b.reg.homeMargin, (b) => b.reg.nHome, regHomeN),
      preHomeN,
    };
  })();
  function setPreHcaFactor(v: number) {
    if (!Number.isFinite(v)) return;
    const c = Math.max(0, Math.min(1.5, v));
    setPreHcaFactorState(c);
    try {
      localStorage.setItem(PRE_HCA_KEY, String(c));
    } catch {
      // ei haittaa
    }
  }
  useEffect(() => {
    const d = new Date();
    setGameDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`);
  }, []);

  // Vedonlyöntilinjat (kotijoukkueen tasoitus, over/under-raja).
  const [spreadLine, setSpreadLine] = useState("");
  // Kierros: kertoimet The Odds API:sta (/api/odds).
  const [oddsEvents, setOddsEvents] = useState<OddsEvent[]>([]);
  const [oddsInfo, setOddsInfo] = useState<string | null>(null);
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsBook, setOddsBook] = useState("consensus");
  async function loadOdds(refresh = false) {
    setOddsLoading(true);
    setOddsInfo(null);
    try {
      const res = await fetch(`/api/odds${refresh ? "?refresh=1" : ""}`);
      const data = await res.json().catch(() => ({ error: `palvelin vastasi ${res.status}` }));
      if (!res.ok) {
        setOddsInfo(`Virhe: ${data.error ?? res.status}`);
      } else {
        setOddsEvents(data.events ?? []);
        const t = data.fetchedAt ? new Date(data.fetchedAt).toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" }) : "";
        setOddsInfo(`${(data.events ?? []).length} ottelua, haettu ${t}${data.cached ? " (välimuisti)" : ""}${data.remaining ? ` · krediittejä jäljellä ${data.remaining}` : ""}`);
      }
    } catch (e: any) {
      setOddsInfo(`Virhe: ${e?.message ?? "tuntematon virhe"}`);
    } finally {
      setOddsLoading(false);
    }
  }
  const [totalLine, setTotalLine] = useState("");

  // Tämän ottelun kokoonpano: pelaajakohtaiset minuutit (ohittaa oletuksen)
  // ja valitut aloittajat per joukkue.
  const [gameMin, setGameMin] = useState<Record<string, number>>({});
  const [secret, setSecretState] = useState("");
  // --- Mallin asetukset tietokantaan (app_settings.model): samat kaikilla laitteilla ---
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [settingsInfo, setSettingsInfo] = useState<string | null>(null);
  useEffect(() => {
    (async () => {
      try {
        const j = await fetch("/api/settings").then((r) => r.json());
        if (j.error) setSettingsInfo(`Asetuksia ei saatu tietokannasta: ${j.error}`);
        const m = j?.settings?.model;
        if (m) {
          if (typeof m.blendWeight === "number") setBlendWeight(m.blendWeight);
          if (m.carry && typeof m.carry.player === "number") setCarry(m.carry);
          if (typeof m.leagueNorm === "boolean") setLeagueNorm(m.leagueNorm);
          if (typeof m.injuryAdj === "boolean") setInjuryAdj(m.injuryAdj);
          if (typeof m.marketWeight === "number") setMarketWeight(m.marketWeight);
          if (typeof m.paceShift === "number") setPaceShift(m.paceShift);
          if (typeof m.alpha === "number") setAlpha(m.alpha);
          if (typeof m.paceAlpha === "number") setPaceAlpha(m.paceAlpha);
          if (m.paceMethod === "excel" || m.paceMethod === "additive" || m.paceMethod === "average") setPaceMethod(m.paceMethod);
          if (typeof m.b2bPaceAdj === "number") setB2bPaceAdj(m.b2bPaceAdj);
          if (typeof m.b2bPenalty === "number") setB2bPenalty(m.b2bPenalty);
          if (typeof m.threeInFourPenalty === "number") setThreeInFourPenalty(m.threeInFourPenalty);
          if (typeof m.marginSd === "number") setMarginSd(m.marginSd);
          if (typeof m.totalSd === "number") setTotalSd(m.totalSd);
          if (m.ratingSource === "epm" || m.ratingSource === "darko" || m.ratingSource === "avg") setRatingSource(m.ratingSource);
          if (typeof m.preHcaFactor === "number") setPreHcaFactor(m.preHcaFactor);
          if (typeof m.preTotalShift === "number") setPreTotalShift(m.preTotalShift);
          if (m.venues && typeof m.venues === "object") {
            setVenueOverrideState(m.venues);
            try {
              localStorage.setItem(VENUE_KEY, JSON.stringify(m.venues));
            } catch {
              // ei haittaa
            }
          }
          setSettingsInfo("Asetukset ladattu tietokannasta.");
        }
      } catch {
        setSettingsInfo("Asetuksia ei saatu tietokannasta — käytetään tämän selaimen asetuksia.");
      } finally {
        setSettingsLoaded(true);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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
          fetch("/api/schedule", { cache: "no-store" }),
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
          const pr = await fetch("/api/prev-season").then((r) => r.json());
          setPrevRows((pr.rows ?? []).map((r: any) => ({ ...r, gp: Number(r.gp) || 0, min_total: Number(r.min_total) || 0 })));
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
      if (g.home_ortg == null || g.away_ortg == null || (g as any).season_type === "pre") continue;
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
  const playersLoaded = players.length > 0;
  useEffect(() => {
    if (playersLoaded) setPlayers((prev) => withRatings(prev, ratingSource));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingSource, playersLoaded]);
  const darkoCount = players.filter((p: any) => p.darko_o != null).length;

  const modelSettings = {
    blendWeight, carry, leagueNorm, injuryAdj, marketWeight, paceShift, alpha, paceAlpha, paceMethod,
    b2bPaceAdj, b2bPenalty, threeInFourPenalty, marginSd, totalSd, ratingSource,
    preHcaFactor, preTotalShift,
    // Pelipaikat: vain viimeisen 60 päivän ottelut (avain alkaa päivämäärällä).
    venues: (() => {
      const cut = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
      return Object.fromEntries(Object.entries(venueOverride).filter(([k]) => k.slice(0, 10) >= cut));
    })(),
  };
  const modelSettingsJson = JSON.stringify(modelSettings);
  useEffect(() => {
    if (!settingsLoaded || !secret) return;
    const t = setTimeout(async () => {
      try {
        const res = await fetch("/api/settings", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
          body: JSON.stringify({ key: "model", value: JSON.parse(modelSettingsJson) }),
        });
        const j = await res.json().catch(() => ({}));
        setSettingsInfo(res.ok ? `Asetukset tallennettu tietokantaan ${new Date().toLocaleTimeString("fi-FI", { hour: "2-digit", minute: "2-digit" })}.` : `Asetusten tallennus epäonnistui: ${j.error ?? res.status}`);
      } catch (e: any) {
        setSettingsInfo(`Asetusten tallennus epäonnistui: ${e?.message ?? e}`);
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [modelSettingsJson, settingsLoaded, secret]);

  // Kauden lähtötaso (regressio + kesän muutos + win totalit) — sama kuin Teams-sivulla.
  const pre = useMemo(
    () => computePreseason(teams, players, prevRows, { blendWeight, carry, leagueNorm, marketWeight, paceShift, injuryAdj }, undefined, games as any),
    [teams, players, prevRows, blendWeight, carry, leagueNorm, marketWeight, paceShift, injuryAdj, games]
  );
  const offseasonNorm = { meanO: pre.meanO, meanD: pre.meanD };
  const offseason = pre.offseason;
  // Kauden ensimmäinen ottelupäivä otteluohjelmasta. Sitä ennen kirjatut siirrot
  // ovat kesän siirtoja, jotka sisältyvät jo rosteripohjaiseen kesän muutokseen.
  const seasonStart = useMemo(() => games.reduce((m, g) => ((g as any).season_type !== "pre" && g.date && g.date < m ? g.date : m), "9999-12-31"), [games]);

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
    // Minuutit, joita kukaan ei pelaa (poissaolot ilman käsin jakoa), pelaa korvaavan tason
    // pelaaja (O ${REPL_O} / D ${REPL_D}), ei liigan keskitaso. Vaimenee samoin kuin poissaolot.
    const fill = Math.max(0, 240 - total);
    if (fill > 0.5) {
      o += ((REPL_O * fill) / 48) * redistDecay;
      d += ((REPL_D * fill) / 48) * redistDecay;
    }
    return { o, d, total, fill, roster };
  }

  const winTotalView = { rows: pre.winRows };
  const [calib, setCalib] = useState<ReturnType<typeof calibrateCarry> | null>(null);
  function runCalibration() {
    setCalib(calibrateCarry(teams, players, prevRows, { blendWeight, carry, leagueNorm, marketWeight, injuryAdj }, games as any));
  }

  function finalStatsFor(team: TeamStats | undefined) {
    if (!team) return null;
    const pr = pre.byTeam[team.team];
    if (!pr) return null;
    // Lähtötaso sisältää regression ja mahdollisen win total -siirron; kesän muutos lisätään alla.
    const ortgBlend = pr.ortgBlend;
    const drtgBlend = pr.drtgBlend;
    const paceBlend = pr.paceBlend;
    const resO = pr.resO;
    const resD = pr.resD;

    const played = gamesByTeam[team.team] ?? [];

    // Kesän muutos (rosteri nyt vs. viime kauden vaikutusminuutit) lisätään
    // lähtötasoon ennen EWMA:a, joten se hiipuu pelien myötä samaa tahtia kuin
    // viime kauden luvut.
    const off = usePrev ? offseason[team.team] : undefined;
    const offO = pr.offO;
    const offD = pr.offD;
    const ortgActual = ewma(ortgBlend + offO, played.map((g) => g.ortg), alpha);
    const drtgActual = ewma(drtgBlend - offD, played.map((g) => g.drtg), alpha);
    const paceActual = ewma(paceBlend, played.map((g) => g.pace), paceAlpha);

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
      resO,
      resD,
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
    const played = new Set(games.filter((g) => (g as any).season_type !== "pre" && (g.home === team || g.away === team)).map((g) => g.date));
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
  function project(hO: number, hD: number, aO: number, aD: number, pace: number, hca: number, hB2B: number, aB2B: number, totShift = 0) {
    const homePts = (hO + aD - leagueAvg) * (pace / 100) + hca / 2 - hB2B / 2 + aB2B / 2 + totShift / 2;
    const awayPts = (aO + hD - leagueAvg) * (pace / 100) - hca / 2 + hB2B / 2 - aB2B / 2 + totShift / 2;
    return { homePts, awayPts, margin: homePts - awayPts, total: homePts + awayPts };
  }

  // Pelipaikka: käsin valittu tai otteluohjelmasta (harjoituspeli → "pre").
  const venueKey = (h: string, a: string) => `${gameDate}|${h}|${a}`;
  function venueAuto(h: string, a: string): Exclude<Venue, "auto"> {
    if (!gameDate) return "normal";
    const g = games.find((x) => x.date === gameDate && ((x.home === h && x.away === a) || (x.home === a && x.away === h)));
    return g && (g as any).season_type === "pre" ? "pre" : "normal";
  }
  function venueOf(h: string, a: string): Exclude<Venue, "auto"> {
    const o = venueOverride[venueKey(h, a)];
    return o && o !== "auto" ? o : venueAuto(h, a);
  }
  // Harjoituspeli = otteluohjelman mukaan harjoituspeli tai käsin valittu "Harjoituspeli (koti)".
  const isPreGame = (h: string, a: string) => venueOf(h, a) === "pre" || venueAuto(h, a) === "pre";
  const totShiftFor = (h: string, a: string) => (isPreGame(h, a) ? preTotalShift : 0);
  function hcaFor(t: TeamStats, a: string): number {
    const v = venueOf(t.team, a);
    const base = t.home_adv ?? 0;
    return v === "neutral" ? 0 : v === "pre" ? base * preHcaFactor : base;
  }

  const projection = (() => {
    if (!home || !away || !homeFinal || !awayFinal) return null;
    const b2bCount = (fatigueOf(home.team) === "b2b" ? 1 : 0) + (fatigueOf(away.team) === "b2b" ? 1 : 0);
    const pace = gamePace(homeFinal.paceActual, awayFinal.paceActual) + b2bPaceAdj * b2bCount;
    const hca = hcaFor(home, away.team);
    const hB2B = fatiguePts(fatigueOf(home.team));
    const aB2B = fatiguePts(fatigueOf(away.team));
    const ts = totShiftFor(home.team, away.team);
    const adj = project(homeFinal.finalOrtg, homeFinal.finalDrtg, awayFinal.finalOrtg, awayFinal.finalDrtg, pace, hca, hB2B, aB2B, ts);
    const base = project(homeFinal.modelOrtg, homeFinal.modelDrtg, awayFinal.modelOrtg, awayFinal.modelDrtg, pace, hca, hB2B, aB2B, ts);
    return { pace, hca, hB2B, aB2B, ...adj, base };
  })();

  // Sama laskenta kuin yllä mille tahansa parille (Kierros-näkymä).
  function projectPair(hName: string, aName: string) {
    const h = teams.find((t) => t.team === hName);
    const a = teams.find((t) => t.team === aName);
    const hf = finalStatsFor(h);
    const af = finalStatsFor(a);
    if (!h || !a || !hf || !af) return null;
    const b2bCount = (fatigueOf(h.team) === "b2b" ? 1 : 0) + (fatigueOf(a.team) === "b2b" ? 1 : 0);
    const pace = gamePace(hf.paceActual, af.paceActual) + b2bPaceAdj * b2bCount;
    return project(hf.finalOrtg, hf.finalDrtg, af.finalOrtg, af.finalDrtg, pace, hcaFor(h, a.team), fatiguePts(fatigueOf(h.team)), fatiguePts(fatigueOf(a.team)), totShiftFor(h.team, a.team));
  }

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

  // Harjoituspeli: aloittajat ja rotaation kärki rajataan (oletus 18 min), loput minuutit
  // jaetaan tasaisemmin koko rosterille (myös oletuksena 0 min pelaaville). Säädä sen jälkeen käsin.
  function preseasonMinutes(roster: DbPlayer[], cap = 18) {
    const avail = roster.filter((p) => p.active !== false && !absenceOf(p).out);
    const byBase = [...avail].sort((a, b) => baseMin(b) - baseMin(a));
    const top = byBase.slice(0, 8);
    const rest = byBase.slice(8);
    const result: Record<string, number> = {};
    let used = 0;
    for (const p of top) {
      const m = Math.min(cap, baseMin(p));
      result[p.id] = Math.round(m * 10) / 10;
      used += m;
    }
    const left = Math.max(0, 240 - used);
    if (rest.length > 0) {
      const each = Math.min(28, left / rest.length);
      for (const p of rest) result[p.id] = Math.round(each * 10) / 10;
      used += each * rest.length;
    }
    // jos penkkiä ei ole tarpeeksi, jaetaan ylijäämä kärjelle
    const over = 240 - used;
    if (over > 0.5 && top.length) for (const p of top) result[p.id] = Math.round((result[p.id] + over / top.length) * 10) / 10;
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
          <span style={{ color: minColor }} title={`Puuttuvat minuutit pelaa korvaavan tason pelaaja (O ${REPL_O} / D ${REPL_D} per 100). Skaalaa 240:een jakaa ne sen sijaan rosterin pelaajille.`}>minuutit {lu.total.toFixed(0)}/240{lu.fill > 0.5 ? ` · ${lu.fill.toFixed(0)} min korvaava taso` : ""}</span>
          <button onClick={() => scaleTo240(roster)} style={{ ...smallInput, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>
            Skaalaa 240:een
          </button>
          <button onClick={() => resetLineup(teamName, roster)} style={{ ...smallInput, padding: "2px 8px", fontSize: 11, cursor: "pointer" }}>
            Palauta
          </button>
          <button
            onClick={() => preseasonMinutes(roster)}
            title="Harjoituspeli: rotaation kärki max 18 min, loput tasaisesti penkille. Säädä sen jälkeen käsin."
            style={{ ...smallInput, padding: "2px 8px", fontSize: 11, cursor: "pointer", borderColor: "#a78bfa" }}
          >
            Harjoituspeli
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
                        alkaen · palaa
                        <input
                          type="date"
                          value={p.out_until ?? ""}
                          onChange={(e) => saveAbsence(p, { out_until: e.target.value || null })}
                          title="Arvioitu paluupäivä (tyhjä = ei tiedossa, koko loppukausi). Pelaaja palaa kokoonpanoon automaattisesti tästä päivästä, ja pitkä poissaolo vähennetään kauden keskitasosta (Teams, win totalit, Kausi)."
                          style={{ ...smallInput, padding: "0 3px", fontSize: 10, colorScheme: "dark" }}
                        />
                        · {absence.missed} peliä · vaikutus {Math.round((1 - absence.embedded) * 100)} %
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
        {home && away && (
          <>
            <label style={{ fontSize: 12, color: "#94a3b8", marginLeft: 8 }}>Pelipaikka</label>
            <select
              value={venueOverride[venueKey(home.team, away.team)] ?? "auto"}
              onChange={(e) => setVenueFor(venueKey(home.team, away.team), e.target.value as Venue)}
              title="Auto: harjoituspeli jos ottelu on otteluohjelmassa harjoituspelinä, muuten normaali kotipeli. Neutraali kenttä = kotietu 0."
              style={{ ...smallInput, color: venueOf(home.team, away.team) === "normal" ? undefined : "#fbbf24" }}
            >
              <option value="auto">Auto ({VENUE_LABEL[venueAuto(home.team, away.team)]})</option>
              {(["normal", "pre", "neutral"] as const).map((v) => (
                <option key={v} value={v}>
                  {VENUE_LABEL[v]}
                </option>
              ))}
            </select>
            <span style={{ fontSize: 12, color: "#94a3b8" }}>
              HCA {hcaFor(home, away.team).toFixed(1)}
              {venueOf(home.team, away.team) !== "normal" && <> (norm. {(home.home_adv ?? 0).toFixed(1)})</>}
              {isPreGame(home.team, away.team) && preTotalShift !== 0 && (
                <> · harj. total {preTotalShift > 0 ? "+" : ""}{preTotalShift.toFixed(1)}</>
              )}
            </span>
            {venueOf(home.team, away.team) === "pre" && (
              <label style={{ fontSize: 12, color: "#94a3b8", display: "flex", alignItems: "center", gap: 4 }}>
                × kerroin
                <input
                  type="number"
                  step={0.1}
                  min={0}
                  max={1.5}
                  value={preHcaFactor}
                  onChange={(e) => setPreHcaFactor(Number(e.target.value))}
                  title="Harjoituspelin kotiedun kerroin normaaliin kotietuun verrattuna (oletus 0,5). Koskee kaikkia harjoituspelejä."
                  style={{ ...smallInput, width: 60 }}
                />
              </label>
            )}
          </>
        )}
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

      {(() => {
        const roundEvents = oddsEvents.filter((e) => usGameDate(e.commence) === gameDate);
        const dates = Array.from(new Set(oddsEvents.map((e) => usGameDate(e.commence)))).sort();
        const bookKeys = Array.from(new Map(oddsEvents.flatMap((e) => e.books.map((b) => [b.key, b.title] as const))).entries());
        const sg = (x: number) => `${x > 0 ? "+" : ""}${x.toFixed(1)}`;
        const ev = (p: number, price: number | undefined) => (price ? p * price - 1 : null);
        const evCell = (x: number | null, label: string, extra?: string) =>
          x == null ? (
            <span style={{ color: "#475569" }}>—</span>
          ) : (
            <span style={{ color: x > 0.03 ? "#4ade80" : x > 0 ? "#a3e635" : "#64748b", fontWeight: x > 0.03 ? 700 : 400 }}>
              {label} {(x * 100).toFixed(1)} %{extra ? <span style={{ color: "#64748b", fontWeight: 400 }}> {extra}</span> : null}
            </span>
          );
        const rows = roundEvents
          .map((e) => {
            const lines: BookLines | undefined = oddsBook === "consensus" ? consensus(e) : e.books.find((b) => b.key === oddsBook);
            const pr = projectPair(e.home, e.away);
            return { e, lines, pr };
          })
          .sort((x, y) => {
            const d = (r: typeof x) => (r.pr && r.lines?.spread ? Math.abs(r.pr.margin + r.lines.spread.point) : -1);
            return d(y) - d(x);
          });
        const totGaps = rows.filter((r) => r.pr && r.lines?.total).map((r) => r.lines!.total!.point - r.pr!.total);
        const totGap = totGaps.length ? totGaps.reduce((a, x) => a + x, 0) / totGaps.length : null;
        const spGaps = rows.filter((r) => r.pr && r.lines?.spread).map((r) => -r.pr!.margin - r.lines!.spread!.point);
        const spMae = spGaps.length ? spGaps.reduce((a, x) => a + Math.abs(x), 0) / spGaps.length : null;
        const th = { padding: "6px 8px", fontWeight: 600 as const };
        const td = { padding: "6px 8px", whiteSpace: "nowrap" as const };
        return (
          <details open style={{ ...card, padding: 14, marginBottom: 12 }}>
            <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Kierros — malli vs. markkina ({gameDate || "valitse päivä"})</summary>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "12px 0" }}>
              <button onClick={() => loadOdds(false)} disabled={oddsLoading} style={{ background: "#2563eb", color: "white", border: "none", borderRadius: 6, padding: "6px 14px", fontSize: 12, cursor: "pointer" }}>
                {oddsLoading ? "Haetaan..." : oddsEvents.length ? "Päivitä linjat" : "Hae linjat"}
              </button>
              {oddsEvents.length > 0 && (
                <button onClick={() => loadOdds(true)} disabled={oddsLoading} style={{ ...smallInput, padding: "5px 10px", cursor: "pointer" }} title="Ohittaa 10 min välimuistin (kuluttaa krediittejä)">
                  Pakota uusi haku
                </button>
              )}
              {oddsEvents.length > 0 && (
                <select value={oddsBook} onChange={(e) => setOddsBook(e.target.value)} style={{ ...smallInput }}>
                  <option value="consensus">Konsensus (mediaani, ML ilman marginaalia)</option>
                  {bookKeys.map(([k, t]) => (
                    <option key={k} value={k}>
                      {t}
                    </option>
                  ))}
                </select>
              )}
              {oddsInfo && <span style={{ fontSize: 12, color: oddsInfo.startsWith("Virhe") ? "#f87171" : "#64748b" }}>{oddsInfo}</span>}
            </div>
            {oddsEvents.length > 0 && roundEvents.length === 0 && (
              <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>
                Päivälle {gameDate || "—"} ei ole linjoja. Päivät, joille on linjoja:{" "}
                {dates.map((d) => (
                  <button key={d} onClick={() => setGameDate(d)} style={{ ...smallInput, padding: "1px 8px", marginRight: 4, cursor: "pointer" }}>
                    {d}
                  </button>
                ))}
              </div>
            )}
            {totGap != null && (
              <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                <span>
                  Totalit: markkina keskimäärin <strong style={{ color: Math.abs(totGap) >= 2 ? "#fbbf24" : "#e2e8f0" }}>{totGap >= 0 ? "+" : ""}{totGap.toFixed(1)}</strong> p mallia
                  {totGap >= 0 ? " korkeammalla" : " matalammalla"} ({totGaps.length} peliä)
                  {spMae != null && <> · tasoituksen keskimääräinen ero {spMae.toFixed(1)} p</>}
                </span>
                {Math.abs(totGap) >= 0.5 && (
                  <button
                    onClick={() => setPaceShift(paceShift + totGap / (2 * (leagueAvg / 100)))}
                    style={{ ...smallInput, padding: "3px 10px", cursor: "pointer" }}
                    title="Muuttaa kauden alun tempotasoa niin, että mallin totalit ovat keskimäärin markkinan tasolla (yksittäisten pelien erot jäävät)"
                  >
                    Korjaa tempotaso ({paceShift >= 0 ? "+" : ""}{paceShift.toFixed(1)} → {(paceShift + totGap / (2 * (leagueAvg / 100)) >= 0 ? "+" : "")}{(paceShift + totGap / (2 * (leagueAvg / 100))).toFixed(1)} poss)
                  </button>
                )}
              </div>
            )}
            {rows.length > 0 && (
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
                  <thead>
                    <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                      <th style={th}>Ottelu (vieras @ koti)</th>
                      <th style={th}>Tasoitus malli / markkina</th>
                      <th style={th}>Ero</th>
                      <th style={th}>Tasoitus EV</th>
                      <th style={th}>Total malli / markkina</th>
                      <th style={th}>Total EV</th>
                      <th style={th}>ML koti malli / markkina</th>
                      <th style={th}>ML EV</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(({ e, lines, pr }) => {
                      if (!pr) {
                        return (
                          <tr key={e.id} style={{ borderTop: "1px solid #1f2937" }}>
                            <td style={td}>{e.away} @ {e.home}</td>
                            <td style={{ ...td, color: "#f87171" }} colSpan={7}>Joukkuetta ei löydy Teams-taulusta</td>
                          </tr>
                        );
                      }
                      const modelSpread = -pr.margin; // kotijoukkueen tasoitus vedonlyöntimuodossa
                      const sp = lines?.spread;
                      const tt = lines?.total;
                      const ml = lines?.ml;
                      const pCover = sp ? normCdf((pr.margin + sp.point) / marginSd) : null;
                      const spSideHome = pCover != null && pCover >= 0.5;
                      const spBest = sp ? bestPrice(e, spSideHome ? "spread-home" : "spread-away", spSideHome ? sp.point : sp.point) : null;
                      const spPrice = sp ? (oddsBook === "consensus" ? spBest?.price : spSideHome ? sp.home : sp.away) : undefined;
                      const spEv = pCover != null ? ev(spSideHome ? pCover : 1 - pCover, spPrice) : null;
                      const pOver = tt ? 1 - normCdf((tt.point - pr.total) / totalSd) : null;
                      const overSide = pOver != null && pOver >= 0.5;
                      const ttBest = tt ? bestPrice(e, overSide ? "over" : "under", tt.point) : null;
                      const ttPrice = tt ? (oddsBook === "consensus" ? ttBest?.price : overSide ? tt.over : tt.under) : undefined;
                      const ttEv = pOver != null ? ev(overSide ? pOver : 1 - pOver, ttPrice) : null;
                      const pHome = normCdf(pr.margin / marginSd);
                      const mktHome = ml ? 1 / ml.home / (1 / ml.home + 1 / ml.away) : null;
                      const mlHomeSide = mktHome != null && pHome >= mktHome;
                      const mlBest = ml ? bestPrice(e, mlHomeSide ? "ml-home" : "ml-away") : null;
                      const mlPrice = ml ? (oddsBook === "consensus" ? mlBest?.price : mlHomeSide ? ml.home : ml.away) : undefined;
                      const mlEv = ml ? ev(mlHomeSide ? pHome : 1 - pHome, mlPrice) : null;
                      const diff = sp ? modelSpread - sp.point : null;
                      const short = (t: string) => t.split(" ").pop();
                      return (
                        <tr
                          key={e.id}
                          style={{ borderTop: "1px solid #1f2937", cursor: "pointer" }}
                          title="Avaa ottelu yllä olevaan laskuriin"
                          onClick={() => {
                            setHomeTeam(e.home);
                            setAwayTeam(e.away);
                            if (sp) setSpreadLine(String(sp.point));
                            if (tt) setTotalLine(String(tt.point));
                            window.scrollTo({ top: 0, behavior: "smooth" });
                          }}
                        >
                          <td style={{ ...td, color: "#e2e8f0" }}>
                            {e.away} @ <strong>{e.home}</strong>{" "}
                            <select
                              value={venueOverride[venueKey(e.home, e.away)] ?? "auto"}
                              onClick={(ev) => ev.stopPropagation()}
                              onChange={(ev) => setVenueFor(venueKey(e.home, e.away), ev.target.value as Venue)}
                              title="Pelipaikka: vaikuttaa kotietuun"
                              style={{
                                ...smallInput,
                                padding: "0 4px",
                                fontSize: 11,
                                marginLeft: 4,
                                color: venueOf(e.home, e.away) === "normal" ? "#64748b" : "#fbbf24",
                              }}
                            >
                              <option value="auto">{venueAuto(e.home, e.away) === "pre" ? "auto: harj." : "auto"}</option>
                              <option value="normal">koti</option>
                              <option value="pre">harj. koti</option>
                              <option value="neutral">neutraali</option>
                            </select>
                          </td>
                          <td style={td}>
                            {short(e.home)} {sg(modelSpread)} / {sp ? sg(sp.point) : "—"}
                          </td>
                          <td style={{ ...td, fontWeight: 700, color: diff == null ? "#475569" : Math.abs(diff) >= 4 ? "#f87171" : Math.abs(diff) >= 2 ? "#fbbf24" : "#94a3b8" }}>
                            {diff == null ? "—" : sg(diff)}
                          </td>
                          <td style={td}>
                            {evCell(spEv, `${short(spSideHome ? e.home : e.away)} ${pCover != null ? ((spSideHome ? pCover : 1 - pCover) * 100).toFixed(0) : ""} % ·`, spPrice ? `@${spPrice.toFixed(2)}${oddsBook === "consensus" && spBest ? ` ${spBest.book}` : ""}` : undefined)}
                          </td>
                          <td style={td}>
                            {pr.total.toFixed(1)} / {tt ? tt.point.toFixed(1) : "—"}
                          </td>
                          <td style={td}>
                            {evCell(ttEv, `${overSide ? "Over" : "Under"} ${pOver != null ? ((overSide ? pOver : 1 - pOver) * 100).toFixed(0) : ""} % ·`, ttPrice ? `@${ttPrice.toFixed(2)}${oddsBook === "consensus" && ttBest ? ` ${ttBest.book}` : ""}` : undefined)}
                          </td>
                          <td style={td}>
                            {(pHome * 100).toFixed(0)} % / {mktHome != null ? `${(mktHome * 100).toFixed(0)} %` : "—"}
                          </td>
                          <td style={td}>
                            {evCell(mlEv, `${short(mlHomeSide ? e.home : e.away)} ·`, mlPrice ? `@${mlPrice.toFixed(2)}${oddsBook === "consensus" && mlBest ? ` ${mlBest.book}` : ""}` : undefined)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ fontSize: 11, color: "#64748b", marginTop: 8, lineHeight: 1.6 }}>
                  Järjestetty tasoituseron mukaan. Ero = mallin tasoitus − markkinan tasoitus (kotijoukkue); punainen ≥ 4 p, keltainen ≥ 2 p —
                  isot erot kannattaa tarkistaa (poissaolot, minuutit) ennen kuin niihin luottaa. EV = mallin todennäköisyys × kerroin − 1
                  paremmalle puolelle; konsensuksessa kerroin on paras saatavilla oleva samalla linjalla. Vihreä lihavoitu = EV &gt; 3 %.
                  Mallin väsymys ja kokoonpanot lasketaan valitulle päivälle. Klikkaa riviä avataksesi ottelun laskuriin.
                </div>
              </div>
            )}
          </details>
        );
      })()}

      {winTotalView.rows.length > 0 && (
        <details style={{ ...card, padding: 14, marginBottom: 12 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>Malli vs. win totalit (kauden alun Net)</summary>
          <div style={{ fontSize: 11, color: "#64748b", margin: "8px 0 10px", maxWidth: 820, lineHeight: 1.6 }}>
            Markkinan Net = (win total − 41) / {WINS_PER_NET}, mallin Net = lähtötaso ennen pelattuja otteluita (regressio + kesän
            muutos − tunnetut pitkät poissaolot kauden osuudella), molemmat liigakeskiarvoon nähden. Pitkä poissaolo: merkitse pelaaja poissa ja aseta arvioitu paluupäivä kokoonpanolistassa. Ero pisteinä ja voittoina: positiivinen = markkina pitää joukkuetta parempana kuin
            malli. Isot erot (punainen ≥ 3 p ≈ 8 voittoa) kannattaa tarkistaa: puuttuuko rosterista siirto, loukkaantuminen tai minuutit —
            vai tietääkö markkina jotain, mitä malli ei voi nähdä (tankkaus, valmentaja).
          </div>
          <div style={{ border: "1px solid #334155", borderRadius: 8, padding: 10, marginBottom: 12, maxWidth: 820 }}>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <button onClick={runCalibration} style={{ background: "#2563eb", color: "white", border: "none", borderRadius: 6, padding: "6px 12px", fontSize: 12, cursor: "pointer" }}>
                Kalibroi regressio win totaleihin
              </button>
              <span style={{ fontSize: 11, color: "#64748b" }}>
                Etsii pelaaja- ja jäännöskertoimet, joilla mallin joukkue-erot osuvat lähimmäs markkinaa (vain kaksi yleistä
                kerrointa — joukkuekohtaiset erot jäävät näkyviin).
              </span>
            </div>
            {calib && calib.best && calib.current && (
              <div style={{ fontSize: 12, marginTop: 10, lineHeight: 1.7 }}>
                <div>
                  Nyt (pelaajat {calib.current.player} % · jäännös {calib.current.res} %): keskivirhe{" "}
                  <strong>{calib.current.rmse.toFixed(2)}</strong> Net-pistettä, kulmakerroin {calib.current.slope.toFixed(2)}
                  {calib.current.slope < 0.9 ? " (malli liian hajallaan — markkina regressoi enemmän)" : calib.current.slope > 1.1 ? " (malli liian tiivis)" : ""}
                </div>
                <div>
                  Paras: pelaajat <strong>{calib.best.player} %</strong> · jäännös <strong>{calib.best.res} %</strong> → keskivirhe{" "}
                  <strong>{calib.best.rmse.toFixed(2)}</strong>, kulmakerroin {calib.best.slope.toFixed(2)}{" "}
                  <button
                    onClick={() => setCarry({ ...carry, player: calib.best!.player, res: calib.best!.res })}
                    style={{ ...smallInput, padding: "2px 10px", marginLeft: 6, cursor: "pointer" }}
                  >
                    Ota käyttöön
                  </button>
                </div>
                <div style={{ color: "#64748b", fontSize: 11 }}>
                  Seuraavaksi parhaat:{" "}
                  {calib.grid
                    .slice(1, 6)
                    .map((g) => `${g.player}/${g.res} (${g.rmse.toFixed(2)})`)
                    .join(" · ")}
                  . Jos lähellä parasta on monta hyvin erilaista yhdistelmää, data ei erota niitä — valitse järkevä.
                </div>
              </div>
            )}
          </div>
          <div style={{ overflowX: "auto" }}>
            <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr style={{ color: "#94a3b8", textAlign: "left" }}>
                  {["Joukkue", "Win total", "Markkina Net", "Malli Net", "Poissaolot", "Ero (p)", "Ero (voittoa)"].map((h) => (
                    <th key={h} style={{ padding: "4px 10px" }}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {[...winTotalView.rows]
                  .sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff))
                  .map((r) => (
                    <tr key={r.team} style={{ borderTop: "1px solid #1f2937" }}>
                      <td style={{ padding: "4px 10px" }}>{r.team}</td>
                      <td style={{ padding: "4px 10px" }}>{r.wins}</td>
                      <td style={{ padding: "4px 10px" }}>{signed(r.mkt)}</td>
                      <td style={{ padding: "4px 10px" }}>{signed(r.model)}</td>
                      <td
                        style={{ padding: "4px 10px", color: "#94a3b8", fontSize: 11 }}
                        title="Vähennetty mallin Netistä: (arvio − korvaava taso) × min/48 × poissaolo-osuus × pelaajakerroin. Odotetut = satunnaiset poissaolot (oma ennuste inj82 tai oletus ~23/82), tunnetut = poissa-merkintä + arvioitu paluupäivä. Vain erot joukkueiden välillä merkitsevät (keskiarvo vähennetään)."
                      >
                        {(() => {
                          const pr = pre.byTeam[r.team];
                          if (!pr) return "";
                          const known = pr.avail && pr.avail.list.length > 0
                            ? `${injuryAdj ? " · " : ""}tunnetut ${signed(-(pr.availO + pr.availD))} (${pr.avail.list.map((x) => `${x.name.split(" ").filter((w) => !/^(Jr\.?|Sr\.?|II|III|IV)$/i.test(w)).slice(-1)[0]} ${Math.round(x.share * 100)} %${x.until ? "" : " (ei paluupv.)"}`).join(", ")})`
                            : "";
                          return `${injuryAdj ? `odotetut ${signed(-(pr.injO + pr.injD))}` : ""}${known}`;
                        })()}
                      </td>
                      <td style={{ padding: "4px 10px", fontWeight: 700, color: Math.abs(r.diff) >= 3 ? "#f87171" : Math.abs(r.diff) >= 1.5 ? "#fbbf24" : "#94a3b8" }}>
                        {signed(r.diff)}
                      </td>
                      <td style={{ padding: "4px 10px", color: "#94a3b8" }}>{signed(r.diff * WINS_PER_NET)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </details>
      )}

      {statusMsg && <div style={{ color: "#f87171", fontSize: 13, marginBottom: 12 }}>{statusMsg}</div>}
      {!usePrev && !loading && (
        <div style={{ color: "#fbbf24", fontSize: 12, marginBottom: 12 }}>
          Kauden 25-26 minuutteja ei ole tallennettu — kesän muutokset lasketaan vanhalla tavalla siirtolokista. Aja
          supabase/setup_season_baseline.sql Supabasessa.
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
        <summary style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}>
          Mallin asetukset{" "}
          <span style={{ fontWeight: 400, fontSize: 11, color: settingsInfo?.includes("epäonnistui") || settingsInfo?.includes("ei saatu") ? "#f87171" : "#64748b" }}>
            {settingsInfo ?? ""}
            {!secret && " · Anna CRON_SECRET, niin muutokset tallentuvat tietokantaan (muuten vain tähän selaimeen)."}
          </span>
        </summary>
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
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", margin: "14px 0 4px" }}>
              Kauden alun regressio — säilyy: pelaajat {carry.player} % · jäännös {carry.res} % · tempo {carry.pace} %
              {(carry.player !== DEFAULT_CARRY.player || carry.res !== DEFAULT_CARRY.res || carry.pace !== DEFAULT_CARRY.pace) && (
                <button onClick={() => setCarry(DEFAULT_CARRY)} style={{ ...smallInput, marginLeft: 8, padding: "1px 8px", fontSize: 11, cursor: "pointer" }}>
                  Palauta {DEFAULT_CARRY.player} / {DEFAULT_CARRY.res} / {DEFAULT_CARRY.pace}
                </button>
              )}
            </label>
            {([
              ["player", "Pelaajista selittyvä osa (EPM × minuutit)"],
              ["res", "Jäännös (joukkueen luku − pelaajien osa)"],
              ["pace", "Tempo"],
            ] as const).map(([k, label]) => (
              <div key={k} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 11, color: "#64748b", width: 210 }}>{label}</span>
                <input type="range" min={0} max={100} step={5} value={carry[k]} onChange={(e) => setCarry({ ...carry, [k]: Number(e.target.value) })} style={{ flex: 1 }} />
              </div>
            ))}
            <div style={{ fontSize: 11, color: "#64748b" }}>
              Viime kauden ORTG/DRTG jaetaan kahteen osaan. Pelaajien osa kulkee pelaajien mukana siirroissa (kesän muutos) ja säilyy
              lähes kokonaan. Jäännös on se osa joukkueen luvusta, jota pelaajien EPM ei selitä — tuuri, valmennus, tankkaus — ja se jää
              joukkueelle, vaikka pelaajat lähtisivät, joten se regressoidaan voimakkaasti. Esim. Hornetsin 25-26 Net +4.8, josta
              pelaajat selittävät vain noin 0 ja jäännös noin +5. Kesän muutoksiin sovelletaan samaa pelaajakerrointa. 100 / 100 = ei
              regressiota. Vaikutus hiipuu EWMA:n myötä pelien kertyessä.
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", margin: "14px 0 4px" }}>
              Win totalien paino lähtötasossa: {marketWeight} %
            </label>
            <input type="range" min={0} max={100} step={10} value={marketWeight} onChange={(e) => setMarketWeight(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: "#64748b" }}>
              0 % = malli yksin (win totalit vain vertailussa). Esim. 50 % siirtää jokaisen joukkueen kauden alun Netiä puoliväliin kohti
              markkinan win totalista johdettua Netiä. Vaikutus hiipuu EWMA:n myötä. Win totalit syötetään Teams-sivulla.
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
              Pelattujen otteluiden paino ORTG/DRTG (α): {alpha.toFixed(2)} (~{Math.round(1 / alpha)} pelin muisti)
            </label>
            <input type="range" min={0.02} max={0.3} step={0.01} value={alpha} onChange={(e) => setAlpha(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: "#64748b" }}>
              Backtest 2024-26: 0.03–0.05 paras sekä tasoitukselle että totalille. 0.15 ylireagoi yksittäisiin peleihin — mm. heikkojen
              hyökkäysten totalit jäivät ~5 p liian mataliksi.
              {alpha !== DEFAULT_ALPHA && (
                <button onClick={() => setAlpha(DEFAULT_ALPHA)} style={{ ...smallInput, marginLeft: 6, padding: "1px 8px", fontSize: 11, cursor: "pointer" }}>
                  Palauta {DEFAULT_ALPHA}
                </button>
              )}
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 6, alignItems: "center", marginTop: 14 }}>
              <input type="checkbox" checked={leagueNorm} onChange={(e) => setLeagueNorm(e.target.checked)} />
              Kesän muutos liigakeskiarvoon nähden
            </label>
            <div style={{ fontSize: 11, color: "#64748b" }}>
              Joukkueiden Net-lukujen summa on aina 0, joten jos kaikki &quot;paranevat&quot;, se on mallin harha. Päällä: liigan
              keskimääräinen muutos (nyt O {offseasonNorm.meanO >= 0 ? "+" : ""}{offseasonNorm.meanO.toFixed(2)}, D{" "}
              {offseasonNorm.meanD >= 0 ? "+" : ""}{offseasonNorm.meanD.toFixed(2)}) vähennetään jokaiselta.
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "flex", gap: 6, alignItems: "center", marginTop: 14 }}>
              <input type="checkbox" checked={injuryAdj} onChange={(e) => setInjuryAdj(e.target.checked)} />
              Odotetut poissaolot kauden tasoon
            </label>
            <div style={{ fontSize: 11, color: "#64748b" }}>
              Päällä: jokaisen rotaatiopelaajan odotetut poissaolot (inj82 tai oletus) vähennetään kauden keskitasosta (win total -vertailu,
              kalibrointi, Teams) ja arvotaan Kausi-simulaatiossa kaikille rotaatiopelaajille. Pois: vanha tapa (ei vähennystä, simulaatiossa
              vain 3 tähteä). Ei vaikuta yksittäisiin otteluihin. Vertaa kalibroinnin keskivirhettä kummallakin.
            </div>
          </div>
          <div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>CRON_SECRET (poissaolojen tallennus)</label>
            <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} style={{ ...smallInput, width: 160, marginBottom: 12 }} />
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Pelaaja-arviot</label>
            <select value={ratingSource} onChange={(e) => setRatingSource(e.target.value as RatingSource)} style={{ ...smallInput, width: "100%", marginBottom: 4 }}>
              {(Object.keys(RATING_LABEL) as RatingSource[]).map((k) => (
                <option key={k} value={k}>
                  {RATING_LABEL[k]}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              DARKO-luku {darkoCount} / {players.length} pelaajalla (tuonti: Players → DARKO). Ilman DARKOa pelaaja käyttää EPM:ää.
              Aja kalibrointi uudelleen lähteen vaihdon jälkeen.
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Tempokaava</label>
            <select value={paceMethod} onChange={(e) => setPaceMethod(e.target.value as PaceMethod)} style={{ ...smallInput, width: "100%", marginBottom: 4 }}>
              {(Object.keys(PACE_LABEL) as PaceMethod[]).map((m) => (
                <option key={m} value={m}>
                  {PACE_LABEL[m]}
                </option>
              ))}
            </select>
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              Liigan keskipace {leaguePace.toFixed(1)}. Regressio kausilta 2024-25 ja 2025-26 (2460 ottelua): ottelun tempo =
              liiga + 1.0 × (koti − liiga) + 1.0 × (vieras − liiga), eli additiivinen. Excel-kaava toimii vain kauden alussa,
              kun luvut ovat viime kaudelta.
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>
              Tempon α: {paceAlpha.toFixed(2)} (~{Math.round(1 / paceAlpha)} pelin muisti)
              {paceAlpha !== DEFAULT_PACE_ALPHA && (
                <button onClick={() => setPaceAlpha(DEFAULT_PACE_ALPHA)} style={{ ...smallInput, marginLeft: 8, padding: "1px 8px", fontSize: 11, cursor: "pointer" }}>
                  Palauta {DEFAULT_PACE_ALPHA}
                </button>
              )}
            </label>
            <input type="range" min={0.02} max={0.3} step={0.01} value={paceAlpha} onChange={(e) => setPaceAlpha(Number(e.target.value))} style={{ width: "100%" }} />
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              Erillään ratingien α:sta: tempo on vakaampi, ja 0.08 oli paras 2025-26 kauden simulaatiossa.
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>B2B:n tempovaikutus (poss / B2B-joukkue)</label>
            <input type="number" step="0.05" value={b2bPaceAdj} onChange={(e) => setB2bPaceAdj(parseFloat(e.target.value) || 0)} style={{ ...smallInput, width: 70, marginBottom: 4 }} />
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>Regressio: −0.45 per B2B-joukkue. 3 peliä / 4 pv ei vaikuta tempoon.</div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Kauden alun tempotaso (poss, kaikille joukkueille)</label>
            <input type="number" step="0.1" value={paceShift} onChange={(e) => setPaceShift(parseFloat(e.target.value) || 0)} style={{ ...smallInput, width: 70, marginBottom: 4 }} />
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              Nostaa kaikkien lähtötempoa (hiipuu pelien myötä). Loka–marraskuussa tempo on ollut ~1.2–1.5 poss kauden keskiarvoa
              korkeampi. Kalibroi Kierros-näkymän napilla markkinan totaleihin.
            </div>
            <label style={{ fontSize: 12, color: "#94a3b8", display: "block", marginBottom: 4 }}>Harjoituspelien total-korjaus (pistettä / peli)</label>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
              <input type="number" step="0.5" value={preTotalShift} onChange={(e) => setPreTotalShift(parseFloat(e.target.value) || 0)} style={{ ...smallInput, width: 70 }} />
              <button onClick={loadPreHist} disabled={!!preHistMsg && preHistMsg.startsWith("Haetaan")} style={{ ...smallInput, padding: "4px 10px", cursor: "pointer" }}>
                Hae 3 edellisen kauden harjoituspelit
              </button>
            </div>
            {preHistMsg && <div style={{ fontSize: 11, color: preHistMsg.startsWith("Virhe") ? "#f87171" : "#94a3b8", marginBottom: 4 }}>{preHistMsg}</div>}
            {preHist && preHist.length > 0 && (
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4, overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", fontVariantNumeric: "tabular-nums" }}>
                  <thead>
                    <tr style={{ textAlign: "right" }}>
                      <th style={{ textAlign: "left", padding: "2px 6px" }}>Kausi</th>
                      <th style={{ padding: "2px 6px" }}>Harj. n</th>
                      <th style={{ padding: "2px 6px" }}>Harj. total</th>
                      <th style={{ padding: "2px 6px" }}>Runkos. 3 vk total</th>
                      <th style={{ padding: "2px 6px" }}>Ero</th>
                      <th style={{ padding: "2px 6px" }}>Harj. pace</th>
                      <th style={{ padding: "2px 6px" }}>Runkos. pace</th>
                      <th style={{ padding: "2px 6px" }}>Kotimarg. harj. / runkos.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preHist.map((b) => (
                      <tr key={b.season} style={{ textAlign: "right", borderTop: "1px solid #1f2937" }}>
                        <td style={{ textAlign: "left", padding: "2px 6px" }}>{b.season}-{String(b.season + 1).slice(2)}</td>
                        <td style={{ padding: "2px 6px" }}>{b.pre.n}{b.pre.nNeutral ? ` (${b.pre.nNeutral} neutr.)` : ""}</td>
                        <td style={{ padding: "2px 6px" }}>{b.pre.total?.toFixed(1) ?? "—"}</td>
                        <td style={{ padding: "2px 6px" }}>{b.reg.total?.toFixed(1) ?? "—"} ({b.reg.n})</td>
                        <td style={{ padding: "2px 6px", color: "#e2e8f0" }}>
                          {b.pre.total != null && b.reg.total != null ? `${b.pre.total - b.reg.total >= 0 ? "+" : ""}${(b.pre.total - b.reg.total).toFixed(1)}` : "—"}
                        </td>
                        <td style={{ padding: "2px 6px" }}>{b.pre.pace?.toFixed(1) ?? "—"}</td>
                        <td style={{ padding: "2px 6px" }}>{b.reg.pace?.toFixed(1) ?? "—"}</td>
                        <td style={{ padding: "2px 6px" }}>
                          {b.pre.homeMargin != null ? `${b.pre.homeMargin >= 0 ? "+" : ""}${b.pre.homeMargin.toFixed(1)}` : "—"} /{" "}
                          {b.reg.homeMargin != null ? `${b.reg.homeMargin >= 0 ? "+" : ""}${b.reg.homeMargin.toFixed(1)}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {preHistSummary && preHistSummary.totalDiff != null && (
                  <div style={{ marginTop: 6, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span>
                      {preHistSummary.nSeasons} kauden keskiarvo: total{" "}
                      <strong style={{ color: "#e2e8f0" }}>
                        {preHistSummary.totalDiff >= 0 ? "+" : ""}
                        {preHistSummary.totalDiff.toFixed(1)}
                      </strong>{" "}
                      p
                      {preHistSummary.paceDiff != null && (
                        <>
                          , tempo {preHistSummary.paceDiff >= 0 ? "+" : ""}
                          {preHistSummary.paceDiff.toFixed(1)} poss
                        </>
                      )}{" "}
                      vs. runkosarjan alku
                    </span>
                    <button onClick={() => setPreTotalShift(preHistSummary.totalDiff!)} style={{ ...smallInput, padding: "2px 8px", cursor: "pointer" }}>
                      Käytä {preHistSummary.totalDiff >= 0 ? "+" : ""}
                      {preHistSummary.totalDiff.toFixed(1)}
                    </button>
                    {preHistSummary.preHome != null && preHistSummary.regHome != null && preHistSummary.regHome > 0.5 && (
                      <>
                        <span>
                          · kotietu harj. {preHistSummary.preHome.toFixed(1)} vs. {preHistSummary.regHome.toFixed(1)} p (n={preHistSummary.preHomeN}, epävarma ±
                          {(14 / Math.sqrt(Math.max(1, preHistSummary.preHomeN))).toFixed(1)})
                        </span>
                        <button
                          onClick={() => setPreHcaFactor(Math.round(Math.max(0, Math.min(1.5, preHistSummary.preHome! / preHistSummary.regHome!)) * 10) / 10)}
                          style={{ ...smallInput, padding: "2px 8px", cursor: "pointer" }}
                        >
                          Kotiedun kerroin {Math.max(0, Math.min(1.5, preHistSummary.preHome / preHistSummary.regHome)).toFixed(1)}
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            <div style={{ fontSize: 11, color: "#64748b", marginBottom: 12 }}>
              Lisätään vain harjoituspelien totaliin (otteluohjelman harjoituspelit ja käsin harjoituspeliksi merkityt). Vertailu: harjoituspelit vs.
              saman kauden runkosarjan 3 ensimmäistä viikkoa, NBA-joukkueiden väliset pelit. Kotietu lasketaan ilman neutraaleja kenttiä.
              Nykyinen kotiedun kerroin {preHcaFactor.toFixed(1)}.
            </div>
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
                  {["Joukkue", "Lähtötaso O/D (regressoitu)", "Jäännös O/D (ennen regr.)", "Kesän muutos O/D", "Pelattu", "EWMA O/D", usePrev ? "Kauden siirrot O/D" : "Siirrot O/D", "Kokoonpano O/D", "Final ORTG", "Final DRTG", "Pace", "HCA"].map((h) => (
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
                    <td style={{ padding: 6, color: "#64748b" }}>
                      {usePrev ? `${signed(f.resO, 1)} / ${signed(f.resD, 1)}` : "—"}
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
              ? "Kesän muutos = Σ nykyinen rosteri (EPM × oletusmin / 48) − Σ kauden 25-26 pelaajat (EPM × (kokonaisminuutit / 82) / 48); molemmat skaalattu 240 minuuttiin" + (leagueNorm ? ` − liigakeskiarvo (O ${offseasonNorm.meanO.toFixed(2)}, D ${offseasonNorm.meanD.toFixed(2)})` : "") + ". Se lisätään lähtötasoon ennen EWMA:a, joten se hiipuu pelien myötä. Kauden aikaiset siirrot painotetaan (1−α)^(pelit siirron jälkeen). "
              : "Kauden 25-26 minuutteja ei ole tallennettu (setup_season_baseline.sql), joten käytetään siirtolokia: "}
            Final ORTG = EWMA ORTG + siirtojen O-delta + kokoonpanon O-delta. Final DRTG =
            EWMA DRTG − treidien D-delta − kokoonpanon D-delta. Kokoonpanon delta = raaka EPM × (tämän ottelun min − oletus min) / 48:
            poissa oleva pelaaja jonka minuutteja ei jaeta muille korvautuu siis korvaavan tason pelaajalla (O −1.0 / D −0.3 per 100). Tuplalaskennan
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
