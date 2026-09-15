import { createClient } from "@supabase/supabase-js";

// SUPABASE_SERVICE_ROLE_KEY on salainen avain — käytetään VAIN palvelinpuolen
// koodissa (API-reiteissä), EI KOSKAAN selaimeen päätyvässä koodissa.
export function getSupabaseAdmin() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY puuttuu ympäristömuuttujista");
  }
  return createClient(url, key, { auth: { persistSession: false } });
}
