// P3-T2 — pure-SVG cumulative-cost sparkline. Renders inside the
// `/loops/[loopId]` server component, so it intentionally avoids
// Recharts (which needs `"use client"`); the existing `<CostCharts>`
// already proves we can keep a server page when Recharts is islanded
// behind a client leaf, but for a single sparkline a hand-rolled
// path is simpler and avoids another browser-measurement boundary.
//
// Shape: takes the iteration array and reduces to cumulative cost
// per step, then stretches the polyline across `width × height` with
// a 2px padding on every side. Edge-cases:
//
//   - `points.length === 0` → render the empty placeholder.
//   - `points.length === 1` → render a single dot at the right edge.
//   - All zeros → render a flat line at the bottom (max=0 fallback).

import type { LoopIterationRow } from "@/src/server/dto";

interface CostSparklineProps {
  iterations: LoopIterationRow[];
  totalCostUsd: number;
  maxCostUsd: number | null;
  width?: number;
  height?: number;
  className?: string;
}

interface PathBuild {
  path: string;
  cumulative: number[];
  max: number;
}

function buildPath(
  iterations: LoopIterationRow[],
  width: number,
  height: number,
  pad: number,
  budgetCap: number | null,
): PathBuild {
  if (iterations.length === 0) {
    return { path: "", cumulative: [], max: 0 };
  }
  const cumulative: number[] = [];
  let acc = 0;
  for (const iter of iterations) {
    acc += Math.max(0, iter.costUsd);
    cumulative.push(acc);
  }
  // The sparkline's vertical max is the larger of the budget cap and
  // the largest cumulative point — guarantees the line never clips
  // the top edge while still letting the user see overshoot when no
  // cap is set. Floors at 1e-9 to avoid divide-by-zero.
  const maxFromData = cumulative[cumulative.length - 1] ?? 0;
  const max = Math.max(
    1e-9,
    budgetCap !== null && budgetCap > 0 ? Math.max(budgetCap, maxFromData) : maxFromData,
  );

  const innerW = width - pad * 2;
  const innerH = height - pad * 2;
  const stepX = cumulative.length > 1 ? innerW / (cumulative.length - 1) : 0;

  const segments = cumulative.map((value, i) => {
    const x = pad + i * stepX;
    // SVG y grows downward; invert so the line rises with cost.
    const y = pad + innerH - (value / max) * innerH;
    return `${i === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
  });

  return { path: segments.join(" "), cumulative, max };
}

export function CostSparkline({
  iterations,
  totalCostUsd,
  maxCostUsd,
  width = 320,
  height = 64,
  className,
}: CostSparklineProps) {
  const pad = 2;
  const { path, cumulative, max } = buildPath(
    iterations,
    width,
    height,
    pad,
    maxCostUsd,
  );

  if (cumulative.length === 0) {
    return (
      <div
        className={className}
        data-testid="cost-sparkline"
        data-empty="true"
        aria-label="No iterations yet"
      >
        <svg
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="img"
          aria-hidden="true"
        >
          <line
            x1={pad}
            y1={height - pad}
            x2={width - pad}
            y2={height - pad}
            stroke="hsl(var(--border))"
            strokeDasharray="3 3"
          />
        </svg>
        <p className="mt-1 text-xs text-[hsl(var(--muted-foreground))]">
          No iterations yet — sparkline lights up after the first iter
          completes.
        </p>
      </div>
    );
  }

  // Position of the budget cap line, when set.
  const innerH = height - pad * 2;
  const capY =
    maxCostUsd !== null && maxCostUsd > 0 && max > 0
      ? pad + innerH - (Math.min(maxCostUsd, max) / max) * innerH
      : null;

  // Last point — show as a dot for "current" cost.
  const lastIdx = cumulative.length - 1;
  const innerW = width - pad * 2;
  const stepX = cumulative.length > 1 ? innerW / (cumulative.length - 1) : 0;
  const lastX = cumulative.length === 1 ? width - pad : pad + lastIdx * stepX;
  const lastY =
    pad + innerH - ((cumulative[lastIdx] ?? 0) / max) * innerH;

  return (
    <div
      className={className}
      data-testid="cost-sparkline"
      data-points={String(cumulative.length)}
      data-max={max.toFixed(6)}
    >
      <svg
        viewBox={`0 0 ${width} ${height}`}
        width="100%"
        height={height}
        role="img"
        aria-label={`Cumulative cost across ${cumulative.length} iteration${cumulative.length === 1 ? "" : "s"}: $${totalCostUsd.toFixed(4)}`}
      >
        {capY !== null && (
          <line
            x1={pad}
            y1={capY}
            x2={width - pad}
            y2={capY}
            stroke="hsl(var(--border))"
            strokeDasharray="2 4"
            data-testid="sparkline-cap"
          />
        )}
        {cumulative.length > 1 && (
          <path
            d={path}
            fill="none"
            stroke="#0ea5e9"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}
        <circle
          cx={lastX}
          cy={lastY}
          r={2.5}
          fill="#0ea5e9"
          data-testid="sparkline-cursor"
        />
      </svg>
    </div>
  );
}
