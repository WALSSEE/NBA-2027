import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";
import { normalizePlayerName } from "@/lib/parseTransactions";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Hakee pelaajakuvat ESPN:n joukkuerostereista (NBA:n oma tilastopalvelin
// ei vastaa Vercelin palvelimille). ESPN:n joukkue-id:t ovat 1–30.
// Kuvan osoite tallennetaan players.headshot_url-sarakkeeseen nimen perusteella.
async function fetchRoster(espnTeamId: number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnTeamId}/roster`, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return (data?.athletes ?? []) as any[];
  } finally {
    clearTimeout(timer);
  }
}

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const ids = Array.from({ length: 30 }, (_, i) => i + 1);
  const results = await Promise.allSettled(ids.map((id) => fetchRoster(id)));
  const byName = new Map<string, string>();
  let failedTeams = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") {
      failedTeams += 1;
      continue;
    }
    for (const a of r.value) {
      const href = a?.headshot?.href;
      const name = a?.displayName ?? a?.fullName;
      if (href && name) byName.set(normalizePlayerName(name), href);
    }
  }
  if (byName.size === 0) {
    return NextResponse.json({ error: `ESPN:n rostereita ei saatu haettua (${failedTeams}/30 epäonnistui).` }, { status: 502 });
  }

  const supabase = getSupabaseAdmin();
  const { data: players, error } = await supabase.from("players").select("id, team, name, headshot_url");
  if (error) {
    return NextResponse.json({ error: `${error.message}. Onko supabase/add_players_headshot.sql ajettu?` }, { status: 500 });
  }

  const updates: { id: string; team: string; name: string; headshot_url: string }[] = [];
  const unmatched: string[] = [];
  for (const p of players ?? []) {
    const href = byName.get(normalizePlayerName(p.name));
    if (!href) {
      if (!p.headshot_url) unmatched.push(`${p.name} (${p.team})`);
      continue;
    }
    if (href !== p.headshot_url) updates.push({ id: p.id, team: p.team, name: p.name, headshot_url: href });
  }
  for (let i = 0; i < updates.length; i += 500) {
    const { error: upErr } = await supabase.from("players").upsert(updates.slice(i, i + 500), { onConflict: "id" });
    if (upErr) return NextResponse.json({ error: `Tallennus epäonnistui: ${upErr.message}` }, { status: 500 });
  }
  return NextResponse.json({ ok: true, espnPlayers: byName.size, failedTeams, updated: updates.length, unmatched });
}
