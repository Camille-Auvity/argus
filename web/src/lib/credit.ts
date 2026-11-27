import { tr } from "./i18n";

// Typical CDS spread curves (bp) at the standard tenors, used by the credit page and the portfolio form.

export const CDS_TENORS = [1, 2, 3, 5, 7, 10];

export const CDS_PRESETS: Record<string, { label: string; spreads: number[]; recovery: number }> = {
  a: { label: "Investment grade (A)", spreads: [20, 28, 36, 55, 68, 80], recovery: 0.4 },
  bbb: { label: "Investment grade (BBB)", spreads: [40, 55, 70, 95, 110, 120], recovery: 0.4 },
  bb: { label: "Crossover (BB)", spreads: [120, 160, 200, 260, 290, 310], recovery: 0.4 },
  b: { label: "High yield (B)", spreads: [300, 360, 410, 470, 490, 500], recovery: 0.3 },
  distressed: { get label() { return tr("Stressé (courbe inversée)", "Distressed (inverted curve)"); }, spreads: [1500, 1300, 1150, 1000, 920, 850], recovery: 0.25 },
};
