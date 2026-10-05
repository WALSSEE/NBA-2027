import { NextResponse } from "next/server";
import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

// Sovelluksen asetukset (app_settings): GET kaikki, POST { key, value } (vaatii CRON_SECRET).
export async function GET() {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase.from("app_settings").select("key, value, updated_at");
  if (error) return NextResponse.json({ error: `${error.message}. Onko supabase/add_app_settings.sql ajettu?`, settings: {} }, { status: 500 });
  const settings: Record<string, unknown> = {};
  const updated: Record<string, string> = {};
  for (const r of data ?? []) {
    settings[r.key] = r.value;
    updated[r.key] = r.updated_at;
  }
  return NextResponse.json({ settings, updated });
}

export async function POST(request: Request) {
  if (request.headers.get("authorization") !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const body = await request.json().catch(() => null);
  const key = typeof body?.key === "string" ? body.key.trim() : "";
  if (!key || body?.value === undefined) return NextResponse.json({ error: "key ja value vaaditaan." }, { status: 400 });
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("app_settings")
    .upsert({ key, value: body.value, updated_at: new Date().toISOString() }, { onConflict: "key" });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
