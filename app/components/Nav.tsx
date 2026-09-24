"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/teams", label: "Teams" },
  { href: "/players", label: "Players" },
  { href: "/transactions", label: "Transactions" },
  { href: "/matchup", label: "Matchup" },
  { href: "/games", label: "Games" },
];

// Jaettu yläpalkki/välilehdet kaikille sovelluksen sivuille. Client-
// komponentti koska tarvitsee usePathname:n aktiivisen välilehden
// korostukseen.
export default function Nav() {
  const pathname = usePathname();
  return (
    <nav
      style={{
        display: "flex",
        gap: 4,
        padding: "10px 24px",
        background: "#111827",
        borderBottom: "1px solid #1f2937",
        flexWrap: "wrap",
      }}
    >
      {LINKS.map((l) => {
        const active = pathname === l.href || (l.href !== "/dashboard" && pathname?.startsWith(l.href));
        return (
          <Link
            key={l.href}
            href={l.href}
            style={{
              padding: "6px 12px",
              borderRadius: 6,
              fontSize: 13,
              textDecoration: "none",
              color: active ? "#e2e8f0" : "#94a3b8",
              background: active ? "#1e293b" : "transparent",
              fontWeight: active ? 600 : 400,
            }}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
