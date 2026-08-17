"use client";

import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { Renderer, PropsOf } from "../kinds";
import { SourceMark } from "./display";

/**
 * Charts.
 *
 * The satellite declares what the chart *means* — kind, which key is the axis,
 * which keys are series — and the hub owns every colour, grid line and tick.
 * Series colours are CSS custom properties rather than literals, which SVG
 * accepts as presentation attributes, so a chart re-themes with the rest of the
 * portal instead of carrying its own palette.
 *
 * Chart data is satellite data, so every value is coerced rather than trusted:
 * a string where a number was expected becomes a gap in the series, not a
 * chart that throws during render and takes the screen with it.
 */

const SERIES_COLORS = [
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
  "var(--chart-5)",
  "var(--chart-6)",
] as const;

const colorAt = (index: number): string =>
  SERIES_COLORS[index % SERIES_COLORS.length] as string;

const AXIS = { stroke: "var(--text-muted)", fontSize: 12 } as const;

const TOOLTIP = {
  contentStyle: {
    background: "var(--surface)",
    border: "1px solid var(--border)",
    borderRadius: "var(--radius)",
    color: "var(--text)",
  },
} as const;

type ChartProps = PropsOf<"Chart">;

export const Chart: Renderer<"Chart"> = ({ props }) => {
  const data = (props.data ?? []).map((row) => normalise(row, props));

  return (
    <figure className="r-chart">
      <ResponsiveContainer width="100%" height={260}>
        {body(props, data)}
      </ResponsiveContainer>
      {props.source !== undefined && (
        <figcaption>
          <SourceMark toolCallId={props.source.toolCallId} />
        </figcaption>
      )}
    </figure>
  );
};

/**
 * One row, reduced to the axis label plus the declared series.
 *
 * Keys the chart was not told about are dropped rather than passed through:
 * Recharts would otherwise happily surface an unrelated column in a tooltip,
 * which is a quiet way for a satellite to show a field it did not declare.
 */
function normalise(row: Record<string, unknown>, props: ChartProps): Record<string, unknown> {
  const out: Record<string, unknown> = { [props.xKey]: label(row[props.xKey]) };
  for (const series of props.series) out[series.key] = numeric(row[series.key]);
  return out;
}

function label(value: unknown): string {
  return typeof value === "string" ? value : typeof value === "number" ? String(value) : "";
}

/** `null` rather than 0 — a missing point is a gap, not a reading of zero. */
function numeric(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function body(props: ChartProps, data: Record<string, unknown>[]) {
  const axes = (
    <>
      <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} />
      <XAxis dataKey={props.xKey} {...AXIS} tickLine={false} />
      <YAxis {...AXIS} tickLine={false} axisLine={false} width={48} />
      <Tooltip {...TOOLTIP} />
      <Legend />
    </>
  );

  switch (props.kind) {
    case "line":
      return (
        <LineChart data={data}>
          {axes}
          {props.series.map((series, index) => (
            <Line
              key={series.key}
              type="monotone"
              dataKey={series.key}
              name={series.label}
              stroke={colorAt(index)}
              strokeWidth={2}
              dot={false}
              // Otherwise a `null` splits the line into disconnected segments,
              // which reads as two series rather than one with a gap.
              connectNulls
            />
          ))}
        </LineChart>
      );

    case "bar":
      return (
        <BarChart data={data}>
          {axes}
          {props.series.map((series, index) => (
            <Bar key={series.key} dataKey={series.key} name={series.label} fill={colorAt(index)} />
          ))}
        </BarChart>
      );

    case "area":
      return (
        <AreaChart data={data}>
          {axes}
          {props.series.map((series, index) => (
            <Area
              key={series.key}
              type="monotone"
              dataKey={series.key}
              name={series.label}
              stroke={colorAt(index)}
              fill={colorAt(index)}
              fillOpacity={0.18}
              connectNulls
            />
          ))}
        </AreaChart>
      );

    case "donut": {
      // A donut shows one measure split by category, so only the first declared
      // series is plotted; the axis key names the slices.
      const key = props.series[0]?.key;
      return (
        <PieChart>
          <Tooltip {...TOOLTIP} />
          <Legend />
          <Pie
            data={key === undefined ? [] : data}
            dataKey={key ?? ""}
            nameKey={props.xKey}
            innerRadius="55%"
            outerRadius="80%"
            paddingAngle={2}
          >
            {data.map((_, index) => (
              <Cell key={index} fill={colorAt(index)} />
            ))}
          </Pie>
        </PieChart>
      );
    }
  }
}
