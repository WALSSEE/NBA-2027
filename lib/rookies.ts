// Tulokkaan tulokaskauden arvio varausnumerosta (per 100 poss, EPM/DARKO-asteikko).
// Sovitettu kauden 2025 draftiluokan (25 pelaajaa) tulokaskauden EPM/DARKO-keskiarvoihin:
// O ≈ 0.8 − 0.8·ln(varaus), D ≈ −0.5 (puolustusta ei ennustanut mikään). Yliopiston BPM+ ei
// parantanut ennustetta varausnumeron lisäksi. Kärkeä kutistettu hieman (yksi luokka, vahva top-3).
export function rookieByPick(pick: number): { o: number; d: number } {
  const p = Math.min(60, Math.max(1, Math.round(pick || 60)));
  const o = 0.6 - 0.75 * Math.log(p);
  return { o: Math.round(o * 100) / 100, d: -0.5 };
}

export const ROOKIE_PRESETS = [
  { label: "Varaus 3 (−0.7)", ...rookieByPick(3) },
  { label: "Varaus 10 (−1.6)", ...rookieByPick(10) },
  { label: "Varaus 20 (−2.1)", ...rookieByPick(20) },
  { label: "2. kierros / varaamaton (−2.8)", ...rookieByPick(45) },
];
