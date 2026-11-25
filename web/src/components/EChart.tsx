import { BarChart, HeatmapChart, LineChart, ScatterChart } from "echarts/charts";
import {
  DataZoomComponent, GridComponent, LegendComponent, MarkAreaComponent, MarkLineComponent, TooltipComponent,
  VisualMapComponent,
} from "echarts/components";
import * as echarts from "echarts/core";
import { CanvasRenderer } from "echarts/renderers";
import { useEffect, useRef } from "react";
import { useTheme, type ChartPalette } from "../lib/theme";

echarts.use([
  LineChart, BarChart, ScatterChart, HeatmapChart, GridComponent, TooltipComponent, LegendComponent, MarkLineComponent,
  MarkAreaComponent, DataZoomComponent, VisualMapComponent, CanvasRenderer,
]);

export type EOption = echarts.EChartsCoreOption;

interface Props {
  option: (p: ChartPalette) => EOption;
  height?: number;
  ariaLabel: string;
}

/** ECharts canvas bound to the current theme; re-renders when the option or theme changes. */
export function EChart({ option, height = 300, ariaLabel }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const chart = useRef<echarts.ECharts | null>(null);
  const { palette, mode } = useTheme();

  useEffect(() => {
    if (!ref.current) return;
    chart.current = echarts.init(ref.current, undefined, { renderer: "canvas" });
    const ro = new ResizeObserver(() => chart.current?.resize());
    ro.observe(ref.current);
    return () => {
      ro.disconnect();
      chart.current?.dispose();
      chart.current = null;
    };
  }, [mode]);

  useEffect(() => {
    chart.current?.setOption(withBase(option(palette), palette), { notMerge: true });
  }, [option, palette, mode]);

  return <div ref={ref} style={{ height, width: "100%" }} role="img" aria-label={ariaLabel} />;
}

/** Shared chrome: recessive grid and axes, themed tooltip, system typography. */
function withBase(opt: EOption, p: ChartPalette): EOption {
  const axisStyle = {
    axisLine: { lineStyle: { color: p.axis } },
    axisTick: { show: false },
    axisLabel: { color: p.muted, fontSize: 11 },
    splitLine: { lineStyle: { color: p.grid, width: 1 } },
    nameTextStyle: { color: p.muted, fontSize: 11 },
  };
  const merge = (axis: unknown) =>
    Array.isArray(axis) ? axis.map((a) => deepMerge(axisStyle, a)) : axis ? deepMerge(axisStyle, axis) : axis;
  return {
    animationDuration: 300,
    textStyle: { fontFamily: "Inter Variable, system-ui, sans-serif", color: p.textSecondary },
    grid: { left: 8, right: 16, top: 16, bottom: 8, containLabel: true },
    color: p.series,
    ...opt,
    xAxis: merge((opt as Record<string, unknown>).xAxis),
    yAxis: merge((opt as Record<string, unknown>).yAxis),
    tooltip: deepMerge(
      {
        backgroundColor: p.surface,
        borderColor: p.axis,
        borderWidth: 1,
        textStyle: { color: p.text, fontSize: 12 },
        extraCssText: "box-shadow: 0 6px 20px rgba(0,0,0,.25); border-radius: 8px;",
        axisPointer: { lineStyle: { color: p.muted, type: "dashed" }, crossStyle: { color: p.muted } },
      },
      (opt as Record<string, unknown>).tooltip ?? { trigger: "axis" },
    ),
    legend: (opt as Record<string, unknown>).legend
      ? deepMerge({ textStyle: { color: p.textSecondary, fontSize: 12 }, icon: "roundRect", itemWidth: 12,
        itemHeight: 3, top: 0 }, (opt as Record<string, unknown>).legend)
      : undefined,
  };
}

function deepMerge(base: unknown, over: unknown): unknown {
  if (typeof base !== "object" || base === null || typeof over !== "object" || over === null || Array.isArray(over)) {
    return over === undefined ? base : over;
  }
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}
