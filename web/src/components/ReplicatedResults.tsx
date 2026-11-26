import { Link } from "react-router-dom";
import { tr } from "../lib/i18n";
import { Card } from "./ui";

/** "Working paper": the published results Argus reproduces, as the paper's own table. Every figure here is
 *  stated in docs/METHODOLOGIE.md and checked by the test suite; nothing is a claim about outside use. */

type Pair = [string, string];
const ROWS: { result: Pair; source: Pair; value: Pair; section: string; to: string }[] = [
  { result: ["Put européen dans l'arbre binomial (S = 100, u = 1,2, d = 0,8, R = 1,05, K = 110)",
    "European put on the binomial tree (S = 100, u = 1.2, d = 0.8, R = 1.05, K = 110)"],
    source: ["Cours de finance en temps continu, lecture 2", "Continuous-time finance course, lecture 2"],
    value: ["10,714 (1 période) · 11,820 (2 périodes)", "10.714 (1 period) · 11.820 (2 periods)"], section: "§19.1", to: "/theory/replication" },
  { result: ["Portefeuille à volatilité pilotée, facteur marché 1926-2015", "Volatility-managed portfolio, market factor 1926-2015"],
    source: ["Moreira et Muir (2017), Tableau I", "Moreira and Muir (2017), Table I"],
    value: ["α = 4,9 % par an · β = 0,60 · appraisal ratio 0,33", "α = 4.9% a year · β = 0.60 · appraisal ratio 0.33"], section: "§18.3", to: "/research" },
  { result: ["VIX recalculé depuis la chaîne d'options SPY", "VIX recomputed from the SPY option chain"],
    source: ["CBOE, livre blanc du VIX", "CBOE, VIX white paper"],
    value: ["écart médian ≈ 0,4 point avec ^VIX", "median gap ≈ 0.4 point to ^VIX"], section: "§12.3", to: "/variance" },
  { result: ["Strike de variance par réplication du smile Heston", "Variance strike by replication of the Heston smile"],
    source: ["Heston (1993) ; Carr et Madan (1998)", "Heston (1993); Carr and Madan (1998)"],
    value: ["égal à la variance espérée Heston à 10⁻⁴ près", "equal to the Heston expected variance within 10⁻⁴"], section: "§12.2", to: "/variance" },
  { result: ["Erreur de couverture delta discrète", "Discrete delta-hedging error"],
    source: ["Derman et Kamal (1999)", "Derman and Kamal (1999)"],
    value: ["écart-type ≈ √(π/4) · vega · σ / √N, en 1/√N", "standard deviation ≈ √(π/4) · vega · σ / √N, in 1/√N"], section: "§19.2", to: "/theory/couverture" },
];

const t = (p: Pair) => tr(p[0], p[1]);

export function ReplicatedResults() {
  return (
    <Card title={tr("Résultats publiés reproduits par Argus", "Published results reproduced by Argus")}>
      <div className="table-wrap">
        <table className="data replicated">
          <thead>
            <tr>
              <th>{tr("Résultat", "Result")}</th><th>{tr("Référence", "Reference")}</th>
              <th>{tr("Valeur obtenue", "Value obtained")}</th><th>{tr("Méthodologie", "Methodology")}</th>
            </tr>
          </thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.section + r.result[1]}>
                <td>{t(r.result)}</td>
                <td className="ref">{t(r.source)}</td>
                <td className="num value">{t(r.value).split(" · ").map((part, i) => (
                  <span key={i} className="nowrap">{i > 0 && " · "}{part}</span>
                ))}</td>
                <td><Link to={r.to}>{r.section}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption-note">
        {tr("Chaque valeur est vérifiée par la suite de 225 tests automatisés ; les formules sont dans la ",
          "Every value is checked by the suite of 225 automated tests; the formulas are in the ")}
        <Link to="/documentation">{tr("documentation méthodologique", "methodology document")}</Link>.
      </p>
    </Card>
  );
}
