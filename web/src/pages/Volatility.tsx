import { useQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ApiError, api } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, InfoBox, Segmented, Skeleton, Stat } from "../components/ui";
import { num, pct, signed } from "../lib/format";
import { useTicker } from "../lib/hooks";
import { useTheme, type ChartPalette } from "../lib/theme";
import { locale, tr } from "../lib/i18n";

const MAX_SERIES = 6; // fixed categorical slots; more expiries would need folding

export default function Volatility() {
  const { ticker } = useTicker();
  const { palette } = useTheme();
  const { data, error, isLoading } = useQuery({ queryKey: ["smile", ticker], queryFn: () => api.smile(ticker), retry: false });
  const [axis, setAxis] = useState<"moneyness" | "strike">("moneyness");
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (!data) return;
    const beyondWeek = data.expiries.filter((e) => e.days >= 7).map((e) => e.expiry);
    setSelected((beyondWeek.length ? beyondWeek : data.expiries.map((e) => e.expiry)).slice(0, 4));
  }, [data]);

  // colour follows the expiry (its index in the full list), never its rank in the selection
  const colorOf = useMemo(() => {
    const m = new Map<string, number>();
    data?.expiries.forEach((e, i) => m.set(e.expiry, i));
    return (exp: string, p: ChartPalette) => p.series[(m.get(exp) ?? 0) % p.series.length];
  }, [data]);

  const smileOption = useCallback((p: ChartPalette) => ({
    legend: {},
    grid: { top: 34 },
    tooltip: { trigger: "item", formatter: (it: { seriesName: string; value: number[] }) =>
      `${it.seriesName}<br/>${axis === "moneyness" ? `K/S ${num(it.value[0], 3)}` : `K ${num(it.value[0], 2)}`} · IV <b>${pct(it.value[1], 2)}</b>` },
    xAxis: { type: "value", scale: true, },
    yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 0) } },
    series: (data?.expiries ?? []).filter((e) => selected.includes(e.expiry)).map((e) => ({
      type: "line", name: `${e.expiry} (${e.days} j)`, smooth: false, symbolSize: 6, lineStyle: { width: 2 },
      color: colorOf(e.expiry, p),
      itemStyle: { borderColor: p.surface, borderWidth: 1 },
      data: e.points.map((pt) => [axis === "moneyness" ? pt.moneyness : pt.strike, pt.iv]),
      markLine: axis === "moneyness" ? { symbol: "none", silent: true, lineStyle: { color: p.muted, type: "dashed" },
        label: { show: false }, data: [{ xAxis: 1 }] } : undefined,
    })),
  }), [data, selected, axis, colorOf]);

  const termOption = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
    xAxis: { type: "value", axisLabel: { formatter: (v: number) => num(v, 0) } },
    yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 0) } },
    series: [{ type: "line", name: "Vol ATM", symbolSize: 8, lineStyle: { width: 2 }, color: p.series[0],
      data: (data?.atm_term_structure ?? []).map((r) => [Math.round(r.T * 365), r.iv]) }],
  }), [data]);

  const notAvailable = error instanceof ApiError && error.status === 404;
  const atm = data?.atm_term_structure;
  const near = atm?.find((r) => r.T * 365 >= 25) ?? atm?.[0];
  const far = atm?.[atm.length - 1];
  const points = data?.expiries.filter((e) => selected.includes(e.expiry)).flatMap((e) => e.points.map((p) => ({ ...p, expiry: e.expiry }))) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Volatilité implicite", "Implied volatility")} — {ticker}</h1>
          <div className="page-sub">
            {tr("Options OTM, mid bid/ask, IV recalculée par le solveur interne (Brent sur Black-Scholes, taux zéro de la courbe).", "OTM options, bid/ask mid, IV recomputed by the in-house solver (Brent on Black-Scholes, zero rate from the curve).")}
          </div>
        </div>
        {data && <Segmented value={axis} onChange={setAxis} options={[{ value: "moneyness", label: "Moneyness" }, { value: "strike", label: "Strike" }]} />}
      </div>
      {notAvailable ? (
        <InfoBox>{(error as ApiError).message}. {tr("Le smile est disponible pour les sous-jacents US (SPY, QQQ, AAPL…) ; les pricers restent utilisables avec la volatilité réalisée.", "The smile is available for the US underlyings (SPY, QQQ, AAPL…); the pricers still work with the realised volatility.")}</InfoBox>
      ) : (
        <ErrorBox error={error} />
      )}
      {isLoading && <Skeleton height={420} />}
      {data && (
        <div className="grid">
          <div className="grid cols-4">
            <Stat label={tr("Spot de référence", "Reference spot")} value={num(data.spot)} foot={`Snapshot ${new Date(data.asof).toLocaleString(locale())}`} />
            <Stat label={tr(`Vol ATM ${near ? `${Math.round(near.T * 365)} j` : ""}`, `ATM vol ${near ? `${Math.round(near.T * 365)} d` : ""}`)} value={pct(near?.iv, 2)} />
            <Stat label={tr(`Vol ATM ${far ? `${Math.round(far.T * 365)} j` : ""}`, `ATM vol ${far ? `${Math.round(far.T * 365)} d` : ""}`)} value={pct(far?.iv, 2)}
              foot={near && far && far !== near ? tr(`Pente ${signed((far.iv - near.iv) * 100, 2)} pts de vol`, `Slope ${signed((far.iv - near.iv) * 100, 2)} vol pts`) : undefined} />
            <Stat label={tr("Échéances / options", "Expiries / options")} value={`${data.expiries.length} / ${data.expiries.reduce((n, e) => n + e.points.length, 0)}`}
              foot={`q = ${pct(data.dividend_yield, 2)}`} />
          </div>
          <Card title={tr("Smile par échéance", "Smile by expiry")} actions={
            <div className="chip-row">
              {data.expiries.map((e) => {
                const on = selected.includes(e.expiry);
                return (
                  <button key={e.expiry} type="button" className={`chip${on ? " on" : ""}`}
                    disabled={!on && selected.length >= MAX_SERIES}
                    onClick={() => setSelected((s) => on ? s.filter((x) => x !== e.expiry) : [...s, e.expiry])}>
                    <i style={{ background: on ? colorOf(e.expiry, palette) : "transparent", border: `1px solid ${colorOf(e.expiry, palette)}` }} />
                    {e.days} {tr("j", "d")}
                  </button>
                );
              })}
            </div>
          }>
            <EChart option={smileOption} height={520} ariaLabel={tr(`Smile de volatilité implicite de ${ticker}`, `${ticker} implied volatility smile`)} />
          </Card>
          <div className="grid cols-2">
            <Card title={tr("Structure par terme de la vol ATM", "ATM vol term structure")}>
              <EChart option={termOption} height={360} ariaLabel={tr("Volatilité ATM par maturité", "ATM volatility by maturity")} />
            </Card>
            <Card title={tr("IV interne vs fournisseur", "In-house IV vs vendor")} flush>
              <div className="table-wrap" style={{ maxHeight: 400, overflowY: "auto" }}>
                <table className="data">
                  <thead><tr><th>{tr("Échéance", "Expiry")}</th><th>Type</th><th>Strike</th><th>Mid</th><th>{tr("IV interne", "In-house IV")}</th><th>IV Yahoo</th></tr></thead>
                  <tbody>
                    {points.map((p) => (
                      <tr key={`${p.expiry}-${p.option_type}-${p.strike}`}>
                        <td>{p.expiry}</td><td className="muted">{p.option_type}</td><td>{num(p.strike, 1)}</td>
                        <td>{num(p.mid, 2)}</td><td className="strong">{pct(p.iv, 2)}</td><td className="muted">{pct(p.vendor_iv, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          </div>
        </div>
      )}
    </>
  );
}
