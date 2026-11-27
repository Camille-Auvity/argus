import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { api, type BondRequest, type Currency } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, NumberField, Segmented, Skeleton, Stat } from "../components/ui";
import { bp, ccySymbol, num, pct, tenorLabel } from "../lib/format";
import { useDebounced, useTicker } from "../lib/hooks";
import type { ChartPalette } from "../lib/theme";
import { tr } from "../lib/i18n";

const interpLabel = (k: string) => (k === "loglinear_df" ? tr("log-linéaire DF", "log-linear DF") : k === "linear_zero" ? tr("linéaire zéro", "linear zero") : k);

export default function Rates() {
  const { snapshot, ticker } = useTicker();
  const [ccy, setCcy] = useState<Currency>((snapshot?.currency as Currency) ?? "USD");
  const curve = useQuery({ queryKey: ["curve", ccy], queryFn: () => api.curve(ccy) });
  const other = useQuery({ queryKey: ["curve", ccy === "USD" ? "EUR" : "USD"], queryFn: () => api.curve(ccy === "USD" ? "EUR" : "USD") });
  const history = useQuery({ queryKey: ["curve-history", ccy], queryFn: () => api.curveHistory(ccy) });
  const c = curve.data;

  const curveOption = useCallback((p: ChartPalette) => {
    if (!c) return {};
    const interps = Object.keys(c.curves);
    return {
      legend: {},
      grid: { top: 34 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 3) },
      xAxis: { type: "value", max: 30, axisLabel: { formatter: tenorLabel } },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 1) } },
      series: [
        { type: "scatter", name: c.quote_type === "zero" ? tr("Quotes zéro (marché)", "Zero quotes (market)") : tr("Par yields (marché)", "Par yields (market)"), symbolSize: 9,
          color: p.text, itemStyle: { borderColor: p.surface, borderWidth: 2 }, z: 5,
          data: c.quotes.map((q) => [q.tenor, q.rate]) },
        ...interps.flatMap((k, i) => [
          { type: "line", name: tr(`Zéro (${interpLabel(k)})`, `Zero (${interpLabel(k)})`), showSymbol: false, lineStyle: { width: 2 }, color: p.series[i * 2],
            data: c.grid.map((t, j) => [t, c.curves[k].zero[j]]) },
          { type: "line", name: `Forward (${interpLabel(k)})`, showSymbol: false, lineStyle: { width: 1.5, type: "dashed" },
            color: p.series[i * 2 + 1], data: c.grid.map((t, j) => [t, c.curves[k].forward[j]]) },
        ]),
      ],
    };
  }, [c]);

  const spreadOption = useCallback((p: ChartPalette) => {
    const usd = ccy === "USD" ? c : other.data;
    const eur = ccy === "EUR" ? c : other.data;
    if (!usd || !eur) return {};
    const z = (x: typeof usd) => x.curves.loglinear_df.zero;
    return {
      tooltip: { trigger: "axis", valueFormatter: (v: number) => bp(v) },
      xAxis: { type: "value", max: 30, axisLabel: { formatter: tenorLabel } },
      yAxis: { type: "value", axisLabel: { formatter: (v: number) => `${num(v * 1e4, 0)} bp` } },
      series: [{ type: "line", name: "Spread USD − EUR", showSymbol: false, lineStyle: { width: 2 }, color: p.series[0],
        areaStyle: { color: `${p.series[0]}22` }, data: usd.grid.map((t, j) => [t, z(usd)[j] - z(eur)[j]]) }],
    };
  }, [c, other.data, ccy]);

  const historyOption = useCallback((p: ChartPalette) => {
    const h = history.data;
    if (!h) return {};
    const keys = ["0.25", "2", "10", "30"].filter((k) => k in h.series);
    return {
      legend: {},
      grid: { top: 30 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 3) },
      xAxis: { type: "category", data: h.dates, boundaryGap: false },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 1) } },
      series: keys.map((k, i) => ({ type: "line", name: tenorLabel(Number(k)), showSymbol: false, lineStyle: { width: 2 },
        color: p.series[i], data: h.series[k] })),
    };
  }, [history.data]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">{tr("Courbes de taux & obligations", "Rate curves & bonds")}</h1>
          <div className="page-sub">
            {c ? (c.quote_type === "zero"
              ? tr(`BCE — souverains AAA zone euro (Svensson), taux zéro continus du ${c.asof}, utilisés directement comme piliers.`, `ECB — AAA euro-area sovereigns (Svensson), continuous zero rates of ${c.asof}, used directly as pillars.`)
              : tr(`Treasury par yields du ${c.asof} (source ${c.source}), bootstrappés : bills ≤ 6M en dépôts, ≥ 1Y en obligations au pair semestrielles.`, `Treasury par yields of ${c.asof} (source ${c.source}), bootstrapped: bills ≤ 6M as deposits, ≥ 1Y as semi-annual par bonds.`))
              : tr("Chargement…", "Loading…")}
          </div>
        </div>
        <Segmented value={ccy} onChange={setCcy} options={[{ value: "USD", label: "USD · Treasury" }, { value: "EUR", label: tr("EUR · BCE", "EUR · ECB") }]} />
      </div>
      <ErrorBox error={curve.error} />
      <div className="grid">
        <Card title={tr("Zéro-coupon et forwards instantanés", "Zero-coupon and instantaneous forwards")}>
          {c ? <EChart option={curveOption} height={480} ariaLabel={tr(`Courbe ${ccy}`, `${ccy} curve`)} /> : <Skeleton height={360} />}
        </Card>
        <div className="grid cols-2">
          <Card title={tr("Spread de taux zéro USD − EUR", "USD − EUR zero-rate spread")}>
            <EChart option={spreadOption} height={340} ariaLabel={tr("Écart de taux zéro entre USD et EUR", "Zero-rate gap between USD and EUR")} />
          </Card>
          <Card title={tr("Historique (30 dernières séances)", "History (last 30 sessions)")}>
            <EChart option={historyOption} height={340} ariaLabel={tr("Historique des taux par maturité", "Rate history by maturity")} />
          </Card>
        </div>
        <BondDesk ccy={ccy} />
        <FuturesDesk ccy={ccy} ticker={ticker} tickerCcy={snapshot?.currency} />
      </div>
    </>
  );
}

function BondDesk({ ccy }: { ccy: Currency }) {
  const [bond, setBond] = useState<BondRequest>({ currency: ccy, maturity: 10, coupon_rate: ccy === "USD" ? 0.045 : 0.03, frequency: ccy === "USD" ? 2 : 1 });
  const req = useDebounced({ ...bond, currency: ccy });
  const { data, error, isFetching } = useQuery({ queryKey: ["bond", req], queryFn: () => api.bond(req), placeholderData: keepPreviousData });
  const set = (patch: Partial<BondRequest>) => setBond((b) => ({ ...b, ...patch }));
  return (
    <Card title={tr(`Pricing obligataire · courbe ${ccy}`, `Bond pricing · ${ccy} curve`)}>
      <div className="split" style={{ gridTemplateColumns: "280px minmax(0,1fr)" }}>
        <div className="form">
          <div className="form-row">
            <NumberField label={tr("Maturité", "Maturity")} value={bond.maturity} suffix={tr("ans", "years")} min={0.1} max={50} digits={2} onChange={(maturity) => set({ maturity })} />
            <NumberField label="Coupon" value={bond.coupon_rate} suffix="%" scale={100} min={0} max={1} digits={3} onChange={(coupon_rate) => set({ coupon_rate })} />
          </div>
          <Segmented label={tr("Fréquence des coupons", "Coupon frequency")} value={bond.frequency} onChange={(frequency) => set({ frequency })}
            options={[{ value: 1, label: tr("Annuel", "Annual") }, { value: 2, label: tr("Semestriel", "Semi-annual") }, { value: 4, label: tr("Trimestriel", "Quarterly") }]} />
          <ErrorBox error={error} />
        </div>
        <div className={`grid cols-4${isFetching ? " busy" : ""}`}>
          <Stat label={tr("Prix pied de coupon", "Clean price")} value={num(data?.clean_price, 4)} foot={tr(`Plein ${num(data?.dirty_price, 4)}`, `Dirty ${num(data?.dirty_price, 4)}`)} />
          <Stat label={tr("Rendement actuariel", "Yield to maturity")} value={pct(data?.ytm, 3)} foot={tr(`Couru ${num(data?.accrued, 4)}`, `Accrued ${num(data?.accrued, 4)}`)} />
          <Stat label={tr("Duration modifiée", "Modified duration")} value={num(data?.modified_duration, 3)} foot={`Macaulay ${num(data?.macaulay_duration, 3)}`} />
          <Stat label={tr("DV01 (pour 100)", "DV01 (per 100)")} value={num(data?.dv01, 4)} foot={tr(`Convexité ${num(data?.convexity, 2)}`, `Convexity ${num(data?.convexity, 2)}`)} />
        </div>
      </div>
    </Card>
  );
}

function FuturesDesk({ ccy, ticker, tickerCcy }: { ccy: Currency; ticker: string; tickerCcy?: string }) {
  const [eqT, setEqT] = useState(0.25);
  const [bf, setBf] = useState({ maturity: 10, coupon_rate: 0.04, delivery: 0.25, conversion_factor: 1 });
  const eqReq = useDebounced(eqT);
  const bfReq = useDebounced(bf);
  const eq = useQuery({ queryKey: ["eqfut", ticker, eqReq], queryFn: () => api.equityFuture(ticker, eqReq), placeholderData: keepPreviousData });
  const bfut = useQuery({
    queryKey: ["bondfut", ccy, bfReq],
    queryFn: () => api.bondFuture({ ...bfReq, currency: ccy, frequency: ccy === "USD" ? 2 : 1 }),
    placeholderData: keepPreviousData, enabled: bf.delivery < bf.maturity,
  });
  return (
    <div className="grid cols-2">
      <Card title={tr(`Future sur ${ticker} · courbe ${tickerCcy ?? ""}`, `Future on ${ticker} · ${tickerCcy ?? ""} curve`)}>
        <div className="grid" style={{ gridTemplateColumns: "160px 1fr", alignItems: "end" }}>
          <NumberField label={tr("Échéance", "Expiry")} value={eqT} suffix={tr("ans", "years")} min={0.01} max={10} digits={2} onChange={setEqT} />
          <div className="grid cols-2">
            <Stat label={tr("Prix théorique", "Theoretical price")} value={`${num(eq.data?.price, 2)} ${ccySymbol(tickerCcy)}`} />
            <Stat label={tr("Base (F − S)", "Basis (F − S)")} value={num(eq.data?.basis, 2)} />
          </div>
        </div>
        <ErrorBox error={eq.error} />
      </Card>
      <Card title={tr(`Future obligataire · courbe ${ccy}`, `Bond future · ${ccy} curve`)}>
        <div className="form">
          <div className="form-row">
            <NumberField label={tr("Maturité du livrable", "Deliverable maturity")} value={bf.maturity} suffix={tr("ans", "years")} min={0.5} max={50} digits={2} onChange={(maturity) => setBf((b) => ({ ...b, maturity }))} />
            <NumberField label={tr("Coupon du livrable", "Deliverable coupon")} value={bf.coupon_rate} suffix="%" scale={100} digits={3} onChange={(coupon_rate) => setBf((b) => ({ ...b, coupon_rate }))} />
          </div>
          <div className="form-row">
            <NumberField label={tr("Livraison", "Delivery")} value={bf.delivery} suffix={tr("ans", "years")} min={0.01} digits={2} onChange={(delivery) => setBf((b) => ({ ...b, delivery }))} />
            <NumberField label={tr("Facteur de conversion", "Conversion factor")} value={bf.conversion_factor} min={0.01} digits={4} onChange={(conversion_factor) => setBf((b) => ({ ...b, conversion_factor }))} />
          </div>
          <Stat label={tr("Prix du future (livrable unique, sans option CTD)", "Future price (single deliverable, no CTD option)")} value={bf.delivery < bf.maturity ? num(bfut.data?.price, 4) : tr("livraison > maturité", "delivery > maturity")} />
        </div>
      </Card>
    </div>
  );
}
