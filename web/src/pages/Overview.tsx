import { useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { Link } from "react-router-dom";
import { api, type TickerSnapshot } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, Delta, ErrorBox, Skeleton, Sparkline } from "../components/ui";
import { ccySymbol, num, pct, relativeTime, signed, tenorLabel } from "../lib/format";
import { useTicker, useTickers } from "../lib/hooks";
import { useTheme, type ChartPalette } from "../lib/theme";
import { SurveillanceMap } from "../components/Ocelli";
import { TransitMap } from "../components/TransitMap";

export default function Overview() {
  const { data: tickers, error, isLoading } = useTickers();
  const { ticker, snapshot } = useTicker();
  const { design } = useTheme();
  const today = new Date().toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Vue d'ensemble</h1>
          <div className="page-sub" style={{ textTransform: "capitalize" }}>{today}</div>
        </div>
      </div>
      <ErrorBox error={error} />
      {design === "metro" && <TransitMap />}
      {isLoading && <div className="grid cols-4">{Array.from({ length: 8 }, (_, i) => <Skeleton key={i} height={104} />)}</div>}
      {tickers && design === "eyes" && <SurveillanceMap tickers={tickers} />}
      {tickers && design !== "eyes" && (
        <>
          <MarketSection title="États-Unis" list={tickers.filter((t) => t.market === "US")} />
          <MarketSection title="Europe" list={tickers.filter((t) => t.market === "EU")} />
        </>
      )}
      <div className="grid cols-2" style={{ marginTop: 14 }}>
        <PriceCard ticker={ticker} snapshot={snapshot} />
        <CurvesCard />
      </div>
      <div style={{ marginTop: 14 }}>
        <LatestNews />
      </div>
    </>
  );
}

function MarketSection({ title, list }: { title: string; list: TickerSnapshot[] }) {
  const { ticker, setTicker } = useTicker();
  const { palette } = useTheme();
  if (!list.length) return null;
  return (
    <section style={{ marginBottom: 18 }}>
      <div className="nav-section" style={{ padding: "0 0 8px" }}>{title}</div>
      <div className="grid cols-4">
        {list.map((t) => (
          <button key={t.ticker} type="button" className={`card quote-tile${t.ticker === ticker ? " selected" : ""}`}
            onClick={() => setTicker(t.ticker)} style={{ textAlign: "left" }}>
            <div className="row">
              <span className="sym">{t.ticker}</span>
              <Delta value={t.change_pct} pct />
            </div>
            <div className="name">{t.name}</div>
            <div className="row" style={{ marginTop: 8, alignItems: "flex-end" }}>
              <span className="px num">{num(t.last)} <span className="muted" style={{ fontSize: 12 }}>{ccySymbol(t.currency)}</span></span>
              <Sparkline data={t.sparkline} color={palette.series[0]} width={96} height={30} />
            </div>
            <div className="row" style={{ marginTop: 8, fontSize: 11.5 }}>
              <span className="muted">Vol 1M <span className="num secondary">{pct(t.realized_vol_1m, 1)}</span></span>
              <span className="muted">Sentiment <span className="num secondary">{t.sentiment == null ? "—" : signed(t.sentiment, 2)}</span></span>
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}

function PriceCard({ ticker, snapshot }: { ticker: string; snapshot?: TickerSnapshot }) {
  const { data, error } = useQuery({ queryKey: ["history", ticker], queryFn: () => api.history(ticker, 260) });
  const option = useCallback((p: ChartPalette) => ({
    tooltip: { trigger: "axis", valueFormatter: (v: number) => num(v) },
    xAxis: { type: "category", data: data?.dates ?? [], boundaryGap: false, axisLabel: { hideOverlap: true } },
    yAxis: { type: "value", scale: true },
    series: [{
      type: "line", name: ticker, data: data?.close ?? [], showSymbol: false, lineStyle: { width: 2, color: p.series[0] },
      itemStyle: { color: p.series[0] },
      areaStyle: { color: { type: "linear", x: 0, y: 0, x2: 0, y2: 1, colorStops: [
        { offset: 0, color: `${p.series[0]}33` }, { offset: 1, color: `${p.series[0]}00` }] } },
    }],
  }), [data, ticker]);
  return (
    <Card title={`${ticker} — 1 an`} actions={snapshot && <span className="muted num">{snapshot.name}</span>}>
      <ErrorBox error={error} />
      {data ? <EChart option={option} height={340} ariaLabel={`Cours de clôture de ${ticker} sur un an`} /> : <Skeleton height={340} />}
    </Card>
  );
}

function CurvesCard() {
  const usd = useQuery({ queryKey: ["curve", "USD"], queryFn: () => api.curve("USD") });
  const eur = useQuery({ queryKey: ["curve", "EUR"], queryFn: () => api.curve("EUR") });
  const option = useCallback((p: ChartPalette) => {
    const series = [usd.data, eur.data].filter(Boolean).map((c, i) => ({
      type: "line", name: `Zéro ${c!.currency}`, showSymbol: false, lineStyle: { width: 2, color: p.series[i] },
      itemStyle: { color: p.series[i] },
      data: c!.grid.map((t, j) => [t, c!.curves.loglinear_df.zero[j]]),
    }));
    return {
      legend: {},
      grid: { top: 30 },
      tooltip: { trigger: "axis", valueFormatter: (v: number) => pct(v, 2) },
      xAxis: { type: "value", max: 30, axisLabel: { formatter: (v: number) => tenorLabel(v) } },
      yAxis: { type: "value", scale: true, axisLabel: { formatter: (v: number) => pct(v, 1) } },
      series,
    };
  }, [usd.data, eur.data]);
  return (
    <Card title="Courbes zéro-coupon" actions={<Link to="/rates" className="muted">Détail →</Link>}>
      {usd.data || eur.data ? <EChart option={option} height={340} ariaLabel="Courbes de taux zéro USD et EUR" /> : <Skeleton height={340} />}
    </Card>
  );
}

function LatestNews() {
  const { data } = useQuery({ queryKey: ["news", "all"], queryFn: () => api.news(undefined, 8) });
  return (
    <Card title="Dernières news" actions={<Link to="/sentiment" className="muted">Toutes les news →</Link>} flush>
      {!data && <div className="card-body"><Skeleton height={120} /></div>}
      {data?.map((n) => (
        <div key={n.id} className="news-item">
          <div>
            <span className="badge">{n.ticker}</span>
            <div className="num" style={{ marginTop: 6, fontWeight: 600 }}>{n.score == null ? "—" : signed(n.score, 2)}</div>
          </div>
          <div>
            <a className="news-title" href={n.url ?? "#"} target="_blank" rel="noreferrer">{n.title}</a>
            <div className="news-meta">{n.publisher} · {relativeTime(n.published)}</div>
            {n.rationale && <div className="news-why">{n.rationale}</div>}
          </div>
        </div>
      ))}
    </Card>
  );
}
