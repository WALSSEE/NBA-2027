import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { normalizePlayerName } from "@/lib/parseTransactions";
import { looseKey } from "@/lib/prevSeason";

export const dynamic = "force-dynamic";

// Tämä reitti PYYHKII koko players-taulun ja korvaa sen liitetyllä datalla.
// Suojattu samalla CRON_SECRET-arvolla kuin cron-reitit (Vercelissä jo
// asetettu ympäristömuuttuja) — sivu app/players/page.tsx kysyy tämän
// salasanan käyttäjältä ja lähettää sen Authorization-headerissa.
// EPM-päivitys (EPM-sivun joukkue- ja liigatuonti): päivittää VAIN EPM-luvut.
// Minuutit ja joukkue ovat Transactions-sivun hallinnassa, joten niihin ei
// kosketa. Pelaaja tunnistetaan nimellä mistä joukkueesta tahansa (myös
// siirron jälkeen). Uudet nimet lisätään 0 minuutilla.
async function updateEpmOnly(supabase: ReturnType<typeof getSupabaseAdmin>, incoming: { team: string; name: string; pos?: string; oepm: number; depm: number }[]) {
  const existing: any[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase.from("players").select("id, team, name").range(from, from + 999);
    if (error) throw new Error(error.message);
    existing.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  const byNorm = new Map<string, any[]>();
  const byLoose = new Map<string, any[]>();
  for (const p of existing) {
    const n = normalizePlayerName(p.name);
    (byNorm.get(n) ?? byNorm.set(n, []).get(n)!).push(p);
    const lk = looseKey(p.name);
    if (lk) (byLoose.get(lk) ?? byLoose.set(lk, []).get(lk)!).push(p);
  }
  const updates = new Map<string, Record<string, unknown>>();
  const inserts = new Map<string, Record<string, unknown>>();
  for (const r of incoming) {
    let group = byNorm.get(normalizePlayerName(r.name)) ?? [];
    if (group.length === 0) {
      const cands = byLoose.get(looseKey(r.name) ?? "") ?? [];
      if (new Set(cands.map((c) => normalizePlayerName(c.name))).size === 1) group = cands;
    }
    if (group.length === 0) {
      inserts.set(`${r.team}::${r.name}`, { team: r.team, name: r.name, pos: r.pos ?? "", mpg_base: 0, oepm: r.oepm, depm: r.depm, active: true });
      continue;
    }
    for (const p of group) updates.set(p.id, { id: p.id, team: p.team, name: p.name, oepm: r.oepm, depm: r.depm });
  }
  const up = [...updates.values()];
  for (let i = 0; i < up.length; i += 500) {
    const { error } = await supabase.from("players").upsert(up.slice(i, i + 500), { onConflict: "id" });
    if (error) throw new Error(error.message);
  }
  const ins = [...inserts.values()];
  for (let i = 0; i < ins.length; i += 500) {
    const { error } = await supabase.from("players").insert(ins.slice(i, i + 500));
    if (error) throw new Error(error.message);
  }
  return { updated: up.length, added: ins.length };
}

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await request.json().catch(() => null);
  const players = body?.players;
  // mode "replace" (oletus): pyyhkii KOKO players-taulun ja korvaa sen.
  // mode "team": EPM-sivun joukkuetuonti — päivittää vain EPM-luvut (ks. updateEpmOnly)
  // ja poistaa body.removeNames-listan pelaajat joukkueesta.
  // mode "merge": EPM-sivun koko liigan tuonti — päivittää vain EPM-luvut.
  const mode = body?.mode === "team" ? "team" : body?.mode === "merge" ? "merge" : "replace";
  const team = body?.team ? String(body.team).trim() : null;

  if (!Array.isArray(players) || players.length === 0) {
    return NextResponse.json({ error: "Ei pelaajia liitteessä (players-taulukko tyhjä tai puuttuu)." }, { status: 400 });
  }
  if (mode === "team" && !team) {
    return NextResponse.json({ error: "mode=team vaatii team-kentän." }, { status: 400 });
  }

  for (const p of players) {
    const teamOk = mode === "team" ? true : !!p.team;
    if (!teamOk || !p.name) {
      return NextResponse.json({ error: "Jokaisella pelaajalla pitää olla team ja name." }, { status: 400 });
    }
  }

  const supabase = getSupabaseAdmin();

  if (mode === "team") {
    // Joukkueen päivitys EPM-sivulta: upsert liitetyille pelaajille, EI poista
    // automaattisesti niitä joita liitteessä ei ole (esim. käsin lisätyt
    // tulokkaat, joita ei vielä ole EPM-sivulla). Poistetaan vain ne nimet,
    // jotka käyttäjä on erikseen valinnut (body.removeNames).
    let res;
    try {
      res = await updateEpmOnly(
        supabase,
        players.map((p: any) => ({ team: team!, name: p.name, pos: p.pos, oepm: p.oepm ?? 0, depm: p.depm ?? 0 }))
      );
    } catch (e: any) {
      return NextResponse.json({ error: `Tallennus epäonnistui: ${e.message}` }, { status: 500 });
    }
    const removeNames: string[] = Array.isArray(body?.removeNames) ? body.removeNames.map(String) : [];
    if (removeNames.length > 0) {
      const { error: delError } = await supabase.from("players").delete().eq("team", team).in("name", removeNames);
      if (delError) {
        return NextResponse.json(
          { error: `Pelaajat päivitetty, mutta poisto epäonnistui: ${delError.message}` },
          { status: 500 }
        );
      }
    }
    return NextResponse.json({ ok: true, count: res.updated + res.added, added: res.added, removed: removeNames.length });
  }

  if (mode === "merge") {
    try {
      const res = await updateEpmOnly(
        supabase,
        players.map((p: any) => ({ team: p.team, name: p.name, pos: p.pos, oepm: p.oepm ?? 0, depm: p.depm ?? 0 }))
      );
      return NextResponse.json({ ok: true, count: res.updated + res.added, added: res.added });
    } catch (e: any) {
      return NextResponse.json({ error: `Tallennus epäonnistui: ${e.message}` }, { status: 500 });
    }
  }
  // mode "replace": koko roster korvataan kerralla.
  const { error: deleteError } = await supabase.from("players").delete().not("id", "is", null);
  if (deleteError) {
    return NextResponse.json({ error: `Vanhan datan poisto epäonnistui: ${deleteError.message}` }, { status: 500 });
  }

  const rows = players.map((p: any) => ({
    team: p.team,
    name: p.name,
    pos: p.pos ?? "",
    mpg_base: p.mpg_base ?? 0,
    oepm: p.oepm ?? 0,
    depm: p.depm ?? 0,
    active: p.active ?? true,
  }));

  const CHUNK = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const { error: insertError } = await supabase.from("players").insert(chunk);
    if (insertError) {
      return NextResponse.json(
        { error: `Tallennus epäonnistui (${inserted}/${rows.length} tallennettu ennen virhettä): ${insertError.message}` },
        { status: 500 }
      );
    }
    inserted += chunk.length;
  }

  return NextResponse.json({ ok: true, count: inserted });
}

// GET palauttaa nykyisen rosterin (esikatselua / debug-tarkoitukseen).
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("players").select("*").order("team").order("name");
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  return NextResponse.json({ players: data ?? [] });
}
