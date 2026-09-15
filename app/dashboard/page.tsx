import { getSupabaseAdmin } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function DashboardPage() {
  const supabase = getSupabaseAdmin();
  const { data: teams, error } = await supabase
    .from("team_stats")
    .select("*")
    .order("team");

  const { count: scheduleCount } = await supabase
    .from("schedule")
    .select("*", { count: "exact", head: true });

  const { data: recentGames } = await supabase
    .from("schedule")
    .select("*")
    .not("home_score", "is", null)
    .order("date", { ascending: false })
    .limit(10);

  if (error) {
    return (
      <div style={{ padding: 24, fontFamily: "monospace", color: "#f87171" }}>
        Virhe haettaessa dataa: {error.message}
        <br />
        Tarkista että SUPABASE_URL ja SUPABASE_SERVICE_ROLE_KEY on asetettu, ja
        että schema.sql on ajettu Supabasessa.
      </div>
    );
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", background: "#0f172a", color: "#e2e8f0", minHeight: "100vh" }}>
      <h1 style={{ fontSize: 20, marginBottom: 4 }}>NBA-malli — automaattinen data</h1>
      <p style={{ color: "#64748b", fontSize: 13, marginBottom: 4 }}>
        Tämä sivu lukee suoraan Supabase-tietokannasta. Jos taulukko alla on tyhjä,
        cron-tehtäviä ei ole vielä ajettu kertaakaan — ks. README kohta &quot;Ensimmäinen ajo&quot;.
      </p>
      <p style={{ color: "#34d399", fontSize: 13, marginBottom: 24 }}>
        Koko otteluohjelmassa on {scheduleCount ?? 0} ottelua tietokannassa.
      </p>

      <h2 style={{ fontSize: 14, marginBottom: 8 }}>Team stats ({teams?.length ?? 0} riviä)</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 12, marginBottom: 32 }}>
        <thead>
          <tr style={{ color: "#94a3b8", textAlign: "left" }}>
            <th style={{ padding: 4 }}>Joukkue</th>
            <th style={{ padding: 4 }}>ORTG 25-26</th>
            <th style={{ padding: 4 }}>DRTG 25-26</th>
            <th style={{ padding: 4 }}>Pace 25-26</th>
            <th style={{ padding: 4 }}>HCA</th>
          </tr>
        </thead>
        <tbody>
          {(teams ?? []).map((t: any) => (
            <tr key={t.id} style={{ borderTop: "1px solid #1e293b" }}>
              <td style={{ padding: 4 }}>{t.team}</td>
              <td style={{ padding: 4 }}>{t.ortg_2526 ?? "—"}</td>
              <td style={{ padding: 4 }}>{t.drtg_2526 ?? "—"}</td>
              <td style={{ padding: 4 }}>{t.pace_2526 ?? "—"}</td>
              <td style={{ padding: 4 }}>{t.home_adv ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h2 style={{ fontSize: 14, marginBottom: 8 }}>Viimeisimmät automaattisesti haetut tulokset</h2>
      <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: "#94a3b8", textAlign: "left" }}>
            <th style={{ padding: 4 }}>Pvm</th>
            <th style={{ padding: 4 }}>Koti</th>
            <th style={{ padding: 4 }}>Vieras</th>
            <th style={{ padding: 4 }}>Tulos</th>
            <th style={{ padding: 4 }}>Koti ORTG/DRTG/Pace</th>
          </tr>
        </thead>
        <tbody>
          {(recentGames ?? []).map((g: any) => (
            <tr key={g.id} style={{ borderTop: "1px solid #1e293b" }}>
              <td style={{ padding: 4 }}>{g.date}</td>
              <td style={{ padding: 4 }}>{g.home}</td>
              <td style={{ padding: 4 }}>{g.away}</td>
              <td style={{ padding: 4 }}>{g.home_score}–{g.away_score}</td>
              <td style={{ padding: 4 }}>{g.home_ortg} / {g.home_drtg} / {g.home_pace}</td>
            </tr>
          ))}
          {(recentGames ?? []).length === 0 && (
            <tr><td style={{ padding: 4, color: "#64748b" }} colSpan={5}>Ei vielä automaattisesti haettuja tuloksia.</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
