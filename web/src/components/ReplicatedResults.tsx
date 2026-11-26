import { Link } from "react-router-dom";
import { Card } from "./ui";

/** "Working paper": the published results Argus reproduces, as the paper's own table. Every figure here is
 *  stated in docs/METHODOLOGIE.md and checked by the test suite; nothing is a claim about outside use. */

const ROWS: { result: string; source: string; value: string; section: string; to: string }[] = [
  { result: "Put européen dans l'arbre binomial (S = 100, u = 1,2, d = 0,8, R = 1,05, K = 110)", source: "Cours de finance en temps continu, lecture 2",
    value: "10,714 (1 période) · 11,820 (2 périodes)", section: "§19.1", to: "/theory/replication" },
  { result: "Portefeuille à volatilité pilotée, facteur marché 1926-2015", source: "Moreira et Muir (2017), Tableau I",
    value: "α = 4,9 % par an · β = 0,60 · appraisal ratio 0,33", section: "§18.3", to: "/research" },
  { result: "VIX recalculé depuis la chaîne d'options SPY", source: "CBOE, livre blanc du VIX",
    value: "écart médian ≈ 0,4 point avec ^VIX", section: "§12.3", to: "/variance" },
  { result: "Strike de variance par réplication du smile Heston", source: "Heston (1993) ; Carr et Madan (1998)",
    value: "égal à la variance espérée Heston à 10⁻⁴ près", section: "§12.2", to: "/variance" },
  { result: "Erreur de couverture delta discrète", source: "Derman et Kamal (1999)",
    value: "écart-type ≈ √(π/4) · vega · σ / √N, en 1/√N", section: "§19.2", to: "/theory/couverture" },
];

export function ReplicatedResults() {
  return (
    <Card title="Résultats publiés reproduits par Argus">
      <div className="table-wrap">
        <table className="data replicated">
          <thead><tr><th>Résultat</th><th>Référence</th><th>Valeur obtenue</th><th>Méthodologie</th></tr></thead>
          <tbody>
            {ROWS.map((r) => (
              <tr key={r.result}>
                <td>{r.result}</td>
                <td className="ref">{r.source}</td>
                <td className="num value">{r.value.split(" · ").map((part, i) => (
                  <span key={i} className="nowrap">{i > 0 && " · "}{part}</span>
                ))}</td>
                <td><Link to={r.to}>{r.section}</Link></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="caption-note">
        Chaque valeur est vérifiée par la suite de 225 tests automatisés ; les formules sont dans la{" "}
        <Link to="/documentation">documentation méthodologique</Link>.
      </p>
    </Card>
  );
}
