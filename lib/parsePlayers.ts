// Pelaajadatan liittämis-parsinta (Excel/Sheets -> TSV liitetty tekstikenttään).
// Sama logiikka kuin artifaktin (nba_model_app.jsx) parseLeaguePaste-funktiossa:
//  - suomalainen desimaalipilkku (1,23 -> 1.23)
//  - Active-lippu ohjaa minuutteja: Active != 1 -> mpgBase aina 0
//  - EPM-lähde on raaka "Pelaajan EPM (O)/(D)" (jo regressoitu/"expected" taso),
//    EI Active-ehdollista OEPM/DEPM-saraketta.
//
// Käytetään sekä selaimessa (esikatselu) että voidaan käyttää tarvittaessa
// palvelimella, joten ei riipu DOM- tai Node-only API:sta.

export type ParsedPlayer = {
  team: string;
  name: string;
  pos: string;
  mpg_base: number;
  oepm: number;
  depm: number;
  active: boolean;
};

export type ParseResult = {
  players: ParsedPlayer[];
  warnings: string[];
};

function parseFinnishNumber(str: unknown): number {
  if (str === undefined || str === null) return 0;
  const cleaned = String(str).trim().replace(/\s/g, "").replace(",", ".");
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function normalizeHeader(h: string): string {
  return h
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[()]/g, "")
    .trim();
}

// Hyväksytyt otsikkovaihtoehdot per kenttä (normalisoituna normalizeHeader:illa).
const HEADER_ALIASES: Record<string, string[]> = {
  team: ["joukkue", "team"],
  name: ["pelaaja", "nimi", "player", "name"],
  pos: ["pos", "positio", "position"],
  epmO: ["pelaajan epm o", "epm o", "oepm raaka", "epm o raaka"],
  epmD: ["pelaajan epm d", "epm d", "depm raaka", "epm d raaka"],
  baselineMins: ["baseline mins", "baseline minuutit", "oletusminuutit"],
  mins: ["mins", "minuutit", "min"],
  active: ["active", "aktiivinen"],
};

function findColumn(headers: string[], field: string): number {
  const aliases = HEADER_ALIASES[field] ?? [];
  const normalized = headers.map(normalizeHeader);
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias);
    if (idx !== -1) return idx;
  }
  return -1;
}

// --- EPM-sivuston kopiointi (esim. Dunks & Threes -tyyppinen taulukko) ---
//
// Kun taulukon valitsee ja kopioi selaimesta, jokainen solu tulee omalle
// rivilleen, ja jokaista arvoa seuraa oma persentiili-rivinsä. Pelaajan
// nimeä seuraa aina rivi muotoa "DAL · G 6'2\" 195 · 34". Ensimmäiset viisi
// arvo/persentiili-paria ovat aina MPG, USG%, O-EPM, D-EPM, EPM (yhteensä) —
// tarkistettu siitä että O-EPM + D-EPM = EPM (pyöristysvirheen sisällä).
// Tämän jälkeen tulee "-"-rivi ja sitten SCORING/SHOOTING/REBOUNDS/HANDLE/
// DEFENSE-ryhmien arvot, jotka jätetään käyttämättä.

export type SiteParsedPlayer = {
  name: string;
  mpg: number;
  oepm: number;
  depm: number;
  epmTotal: number;
  epmSumOk: boolean;
};

export type SiteParseResult = {
  players: SiteParsedPlayer[];
  warnings: string[];
};

const POS_LINE_RE = /^[A-Z]{2,3}\s*[·:]\s*[A-Z\-]/;

function toNum(s: string | undefined): number | null {
  if (s === undefined) return null;
  const cleaned = s.replace(/[−–]/g, "-").replace(",", ".").trim();
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseEpmSitePaste(raw: string): SiteParseResult {
  const allLines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, "").trim())
    .filter((l) => l.length > 0 && l !== "Search player" && l !== "RK" && !l.startsWith("ROLE"));

  const players: SiteParsedPlayer[] = [];
  const warnings: string[] = [];

  let i = 0;
  const n = allLines.length;
  while (i < n) {
    const line = allLines[i];
    if (i + 1 < n && POS_LINE_RE.test(allLines[i + 1])) {
      const name = line;
      let j = i + 2;
      const values: string[] = [];
      while (values.length < 10 && j < n) {
        values.push(allLines[j]);
        j++;
      }
      if (j < n && allLines[j] === "-") j++;
      // hypätään loppuosan yli seuraavaan pelaajaan asti
      while (j < n) {
        if (j + 1 < n && POS_LINE_RE.test(allLines[j + 1]) && !/^[+\-−]?\d/.test(allLines[j])) {
          break;
        }
        j++;
      }

      const mpg = toNum(values[0]);
      const oepm = toNum(values[4]);
      const depm = toNum(values[6]);
      const epmTotal = toNum(values[8]);

      if (mpg === null || oepm === null || depm === null || epmTotal === null) {
        warnings.push(`Pelaaja "${name}": lukuja ei pystytty tulkitsemaan, rivi jätetty pois.`);
      } else {
        const epmSumOk = Math.abs(oepm + depm - epmTotal) < 0.15;
        if (!epmSumOk) {
          warnings.push(
            `Pelaaja "${name}": O-EPM (${oepm}) + D-EPM (${depm}) ei täsmää EPM-summaan (${epmTotal}) — tarkista rivi.`
          );
        }
        players.push({ name, mpg, oepm, depm, epmTotal, epmSumOk });
      }
      i = j;
    } else {
      i++;
    }
  }

  if (players.length === 0) {
    warnings.push("Yhtään pelaajaa ei tunnistettu. Varmista että liitit koko taulukon otsikkoineen suoraan sivustolta.");
  }

  return { players, warnings };
}

// --- EPM-sivuston "koko liiga" -tuonti ---
//
// Sama rakenne kuin yhden joukkueen sivulla, mutta lista kattaa kaikki
// joukkueet (yleensä EPM-järjestyksessä), ja sivusto näyttää kerrallaan
// vain osan listasta — käyttäjä liittää useita pätkiä peräkkäin, jotka
// yhdistetään (team, name) -avaimella.

export type LeaguePlayer = SiteParsedPlayer & { abbr: string; team: string };
export type LeagueParseResult = { players: LeaguePlayer[]; warnings: string[] };

export function parseEpmLeaguePaste(raw: string, teamByAbbr: Record<string, string>): LeagueParseResult {
  const allLines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, "").trim())
    .filter((l) => l.length > 0 && l !== "Search player" && l !== "RK" && !l.startsWith("ROLE"));

  const posLineWithAbbr = /^([A-Z]{2,3})\s*[·:]\s*[A-Z\-]/;
  const players: LeaguePlayer[] = [];
  const warnings: string[] = [];

  let i = 0;
  const n = allLines.length;
  while (i < n) {
    const line = allLines[i];
    const m = i + 1 < n ? posLineWithAbbr.exec(allLines[i + 1]) : null;
    if (m) {
      const name = line;
      const abbr = m[1];
      const team = teamByAbbr[abbr] ?? abbr;
      let j = i + 2;
      const values: string[] = [];
      while (values.length < 10 && j < n) {
        values.push(allLines[j]);
        j++;
      }
      if (j < n && allLines[j] === "-") j++;
      while (j < n) {
        if (j + 1 < n && posLineWithAbbr.test(allLines[j + 1]) && !/^[+\-−]?\d/.test(allLines[j])) {
          break;
        }
        j++;
      }

      const mpg = toNum(values[0]);
      const oepm = toNum(values[4]);
      const depm = toNum(values[6]);
      const epmTotal = toNum(values[8]);

      if (mpg === null || oepm === null || depm === null || epmTotal === null) {
        warnings.push(`Pelaaja "${name}": lukuja ei pystytty tulkitsemaan, rivi jätetty pois.`);
      } else {
        const epmSumOk = Math.abs(oepm + depm - epmTotal) < 0.15;
        if (!epmSumOk) {
          warnings.push(
            `Pelaaja "${name}" (${abbr}): O-EPM (${oepm}) + D-EPM (${depm}) ei täsmää EPM-summaan (${epmTotal}) — tarkista rivi.`
          );
        }
        players.push({ name, abbr, team, mpg, oepm, depm, epmTotal, epmSumOk });
      }
      i = j;
    } else {
      i++;
    }
  }

  if (players.length === 0) {
    warnings.push("Yhtään pelaajaa ei tunnistettu tästä pätkästä.");
  }

  return { players, warnings };
}

export function parsePlayersPaste(raw: string): ParseResult {
  const warnings: string[] = [];
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.replace(/\r$/, ""))
    .filter((l) => l.trim().length > 0);

  if (lines.length < 2) {
    return { players: [], warnings: ["Liitetyssä datassa pitää olla otsikkorivi ja vähintään yksi datarivi."] };
  }

  const headers = lines[0].split("\t");
  const idxTeam = findColumn(headers, "team");
  const idxName = findColumn(headers, "name");
  const idxPos = findColumn(headers, "pos");
  const idxEpmO = findColumn(headers, "epmO");
  const idxEpmD = findColumn(headers, "epmD");
  const idxBaseline = findColumn(headers, "baselineMins");
  const idxMins = findColumn(headers, "mins");
  const idxActive = findColumn(headers, "active");

  if (idxTeam === -1 || idxName === -1) {
    return {
      players: [],
      warnings: [
        "En löytänyt 'Joukkue'- tai 'Pelaaja'-saraketta otsikkoriviltä. Tarkista että ensimmäinen liitetty rivi on otsikkorivi.",
      ],
    };
  }
  if (idxEpmO === -1) warnings.push("Saraketta 'Pelaajan EPM (O)' ei löytynyt — OEPM-arvot asetettu nollaksi.");
  if (idxEpmD === -1) warnings.push("Saraketta 'Pelaajan EPM (D)' ei löytynyt — DEPM-arvot asetettu nollaksi.");
  if (idxActive === -1) warnings.push("Saraketta 'Active' ei löytynyt — kaikki pelaajat merkitään aktiivisiksi.");

  const players: ParsedPlayer[] = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split("\t");
    const team = (cols[idxTeam] ?? "").trim();
    const name = (cols[idxName] ?? "").trim();
    if (!team || !name) continue;

    const activeRaw = idxActive !== -1 ? (cols[idxActive] ?? "").trim() : "1";
    const active = activeRaw === "1" || activeRaw.toLowerCase() === "true" || activeRaw.toLowerCase() === "kyllä";

    let mpgBase = 0;
    if (active) {
      const mins = idxMins !== -1 ? parseFinnishNumber(cols[idxMins]) : 0;
      if (mins > 0) {
        mpgBase = mins;
      } else if (idxBaseline !== -1) {
        mpgBase = parseFinnishNumber(cols[idxBaseline]);
      }
    }

    players.push({
      team,
      name,
      pos: idxPos !== -1 ? (cols[idxPos] ?? "").trim() : "",
      mpg_base: mpgBase,
      oepm: idxEpmO !== -1 ? parseFinnishNumber(cols[idxEpmO]) : 0,
      depm: idxEpmD !== -1 ? parseFinnishNumber(cols[idxEpmD]) : 0,
      active,
    });
  }

  return { players, warnings };
}
