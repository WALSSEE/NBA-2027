import { resolveTeamNickname } from "./teamNames";

// Jäsentää NBA.com-tyylisen joukkueen offseason-listan, esim.
//
//   Re-signing
//   Jock Landale agrees to 1-year deal (officially announced)
//   Additions
//   Luguentz Dort joins via trade with Thunder (officially announced)
//   Departures
//   Jonathan Kuminga departs via free agency with Wolves (officially announced)
//
// Palauttaa tulijat, lähtijät ja jatkosopimukset. Toinen joukkue ("with X")
// muutetaan täydeksi nimeksi; jos sitä ei ole tai sitä ei tunnisteta,
// otherTeam = null (= vapaa agentti / liigan ulkopuolelle).

export type ParsedMove = {
  kind: "addition" | "departure" | "resign";
  name: string;
  otherTeam: string | null;
  otherTeamRaw: string | null;
  line: string;
};

const VERB_RE =
  /^(.+?)\s+(joins|departs|agrees|re-signs|resigns|signs|is\s|was\s|waived|released|retires|claimed|acquired|traded|exercises|declines|picks up|converts|agreed)\b/i;

export function parseTeamTransactions(raw: string): { moves: ParsedMove[]; skipped: string[] } {
  const moves: ParsedMove[] = [];
  const skipped: string[] = [];
  let section: ParsedMove["kind"] | null = null;

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s•\-*·]+/, "").trim();
    if (!line) continue;
    const lower = line.toLowerCase();

    if (/^re-?signings?$/.test(lower)) {
      section = "resign";
      continue;
    }
    if (/^additions?$/.test(lower)) {
      section = "addition";
      continue;
    }
    if (/^departures?$/.test(lower)) {
      section = "departure";
      continue;
    }
    if (!section) continue;
    if (/complete .* roster|free agent tracker|trade tracker/i.test(line)) continue;

    const m = line.match(VERB_RE);
    if (!m) {
      skipped.push(line);
      continue;
    }
    const name = m[1].trim();

    // Varsinainen tyyppi verbistä, osion otsikko varalla.
    let kind: ParsedMove["kind"] = section;
    if (/^joins/i.test(m[2])) kind = "addition";
    else if (/^departs/i.test(m[2])) kind = "departure";

    const withMatch = line.match(/\bwith\s+(?:the\s+)?([A-Za-z0-9 .']+?)\s*(?:\(|$|,)/);
    const otherTeamRaw = withMatch ? withMatch[1].trim() : null;
    const otherTeam = otherTeamRaw ? resolveTeamNickname(otherTeamRaw) : null;

    moves.push({ kind, name, otherTeam, otherTeamRaw, line });
  }

  return { moves, skipped };
}

// Nimien vertailu: pienet kirjaimet, aksentit pois (Jokić -> jokic), pisteet ja
// Jr./Sr./II/III-päätteet pois.
export function normalizePlayerName(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
