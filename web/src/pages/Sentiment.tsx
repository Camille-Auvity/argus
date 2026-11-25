import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { useCallback, useState } from "react";
import { api } from "../api/client";
import { EChart } from "../components/EChart";
import { Card, ErrorBox, ScoreBar, Segmented, Skeleton, Stat } from "../components/ui";
import { num, relativeTime, signed } from "../lib/format";
import { useStatus, useTicker } from "../lib/hooks";
import { useTheme, type ChartPalette } from "../lib/theme";

export default function Sentiment() {
  const { ticker } = useTicker();
  const { palette } = useTheme();
  const { data: status } = useStatus();
  const qc = useQueryClient();
  const [scope, setScope] = useState<"ticker" | "all">("ticker");
  const summary = useQuery({ queryKey: ["sentiment-summary"], queryFn: api.sentimentSummary });
  const news = useQuery({
    queryKey: ["news", scope === "all" ? "all" : ticker, 150],
    queryFn: () => api.news(scope === "all" ? undefined : ticker, 150),
  });
  const score = useMutation({ mutationFn: api.scoreSentiment, onSuccess: () => qc.invalidateQueries() });

  const barOption = useCallback((rows: { label: string; value: number; n: number }[]) => (p: ChartPalette) => ({
    grid: { left: 8, right: 40, top: 8, bottom: 8, containLabel: true },
    tooltip: { trigger: "item", formatter: (it: { name: string; value: number; dataIndex: number }) =>
      `${it.name}<br/>Sentiment <b>${signed(it.value, 2)}</b> · ${rows[it.dataIndex].n} articles` },
    xAxis: { type: "value", min: -1, max: 1, axisLabel: { formatter: (v: number) => signed(v, 1) } },
    yAxis: { type: "category", data: rows.map((r) => r.label), axisLine: { show: false } },
    series: [{
      type: "bar", barMaxWidth: 16,
      data: rows.map((r) => ({ value: r.value, itemStyle: {
        color: r.value >= 0 ? p.diverging[2] : p.diverging[0],
        borderRadius: r.value >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4] } })),
      label: { show: true, position: "right", color: p.textSecondary, fontSize: 11, formatter: (it: { value: number }) => signed(it.value, 2) },
      markLine: { symbol: "none", silent: true, label: { show: false }, lineStyle: { color: p.axis }, data: [{ xAxis: 0 }] },
    }],
  }), []);

  const s = summary.data;
  const tickerRows = (s?.by_ticker ?? []).slice().sort((a, b) => a.sentiment - b.sentiment)
    .map((r) => ({ label: r.ticker, value: r.sentiment, n: r.n_articles }));
  const sectorRows = (s?.by_sector ?? []).map((r) => ({ label: r.sector, value: r.sentiment, n: r.n_articles }));
  const scored = news.data?.filter((n) => n.score != null) ?? [];
  const mine = s?.by_ticker.find((r) => r.ticker === ticker);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">News & sentiment IA</h1>
          <div className="page-sub">
            Titres scorés par {status?.sentiment_model ?? "Claude"} de −1 à +1 (impact attendu à quelques séances), moyenne pondérée par la récence (demi-vie 3 jours).
          </div>
        </div>
        <button className="btn primary" onClick={() => score.mutate()} disabled={score.isPending || !s?.pending}>
          <Bot size={15} /> {score.isPending ? "Scoring…" : `Scorer ${s?.pending ?? 0} news en attente`}
        </button>
      </div>
      <ErrorBox error={score.error ?? summary.error} />
      {score.data && <div className="info-box" style={{ marginBottom: 12 }}>{score.data.scored} news scorées.</div>}
      <div className="grid">
        <div className="grid cols-4">
          <Stat label={`Sentiment ${ticker}`} value={mine ? signed(mine.sentiment, 2) : "—"} foot={mine ? `${mine.n_articles} articles` : "aucun article scoré"} />
          <Stat label="Articles en base" value={num(s ? s.by_ticker.reduce((n, r) => n + r.n_articles, 0) + s.pending : null, 0)} foot={`${s?.pending ?? 0} en attente de scoring`} />
          <Stat label="Plus positif" value={tickerRows.at(-1)?.label ?? "—"} foot={tickerRows.length ? signed(tickerRows.at(-1)!.value, 2) : undefined} />
          <Stat label="Plus négatif" value={tickerRows[0]?.label ?? "—"} foot={tickerRows.length ? signed(tickerRows[0].value, 2) : undefined} />
        </div>
        <div className="grid cols-2">
          <Card title="Par sous-jacent">
            {s ? <EChart option={barOption(tickerRows)} height={Math.max(220, tickerRows.length * 26)} ariaLabel="Sentiment par sous-jacent" /> : <Skeleton height={260} />}
          </Card>
          <Card title="Par secteur (pondéré par le nombre d'articles)">
            {s ? <EChart option={barOption(sectorRows)} height={Math.max(220, sectorRows.length * 30)} ariaLabel="Sentiment par secteur" /> : <Skeleton height={260} />}
          </Card>
        </div>
        <Card title={`Fil de news (${scored.length} scorées)`} flush actions={
          <Segmented value={scope} onChange={setScope} options={[{ value: "ticker", label: ticker }, { value: "all", label: "Tous" }]} />
        }>
          {!news.data && <div className="card-body"><Skeleton height={200} /></div>}
          {news.data?.length === 0 && <div className="empty">Aucune news en base pour {ticker}.</div>}
          {news.data?.map((n) => (
            <div key={n.id} className="news-item">
              <div>
                <ScoreBar score={n.score} palette={palette.diverging} />
                {scope === "all" && <span className="badge" style={{ marginTop: 6 }}>{n.ticker}</span>}
              </div>
              <div>
                <a className="news-title" href={n.url ?? "#"} target="_blank" rel="noreferrer">{n.title}</a>
                <div className="news-meta">{n.publisher} · {relativeTime(n.published)}{n.label ? ` · ${n.label.replace("_", " ")}` : ""}</div>
                {n.rationale && <div className="news-why">{n.rationale}</div>}
              </div>
            </div>
          ))}
        </Card>
      </div>
    </>
  );
}
