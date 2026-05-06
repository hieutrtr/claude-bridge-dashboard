"use client";

// P3-T6 — Cron picker component. Pure presentational view + an
// interactive wrapper that owns mode (`preset` | `custom`), preset
// selection, and custom-mode raw input. Emits a structured
// `{ cronExpr, intervalMinutes, valid, error?, nextFires[] }` payload
// through `onChange` so the parent dialog stays in control of
// submit-disable state.
//
// View module surface:
//   * `<CronPickerView>` — pure props-driven markup; tested via
//     `renderToStaticMarkup`. Renders preset radios, custom-mode raw
//     input (when active), cronstrue label, next-3 fire-time preview.
//   * `<CronPicker>` — wrapper that owns local state + cron-parser
//     evaluation. Calls `onChange` on every state transition.
//
// Cron daemon-side gap (per T06 spec): the daemon currently only
// accepts `interval_minutes`. The picker rejects expressions with
// non-uniform deltas (e.g. weekday cron `0 9 * * 1-5`) so the dialog
// never submits a cadence the daemon can't honour. When daemon-side
// cron support lands, the picker stays unchanged — only the wire
// shape of `onChange.intervalMinutes` becomes optional.

import { useEffect, useMemo, useState } from "react";
import cronstrue from "cronstrue";

import {
  CRON_PRESETS,
  evaluateCron,
  type CronEvalResult,
} from "@/src/lib/schedule-add-client";

export type CronPickerMode = "preset" | "custom";

export type CronPickerPresetValue =
  (typeof CRON_PRESETS)[number]["value"];

export interface CronPickerOnChange {
  /**
   * Active cron expression — null when in preset mode with the
   * "custom" sentinel selected and no custom expression typed yet.
   */
  cronExpr: string | null;
  /**
   * Computed interval (the daemon's currency). Null when the picker
   * is in an invalid state — the parent should treat this as a
   * "submit blocked" signal.
   */
  intervalMinutes: number | null;
  /** True when the picker has produced a daemon-acceptable cadence. */
  valid: boolean;
  /** Validation message — null when valid; warning when non-uniform. */
  message: string | null;
  /** Next 3 fire times in ISO format (empty when invalid). */
  nextFires: string[];
}

export interface CronPickerViewProps {
  mode: CronPickerMode;
  preset: CronPickerPresetValue;
  customExpr: string;
  evaluation: CronEvalResult;
  humanLabel: string | null;
  onModeChange?: (mode: CronPickerMode) => void;
  onPresetChange?: (preset: CronPickerPresetValue) => void;
  onCustomExprChange?: (value: string) => void;
}

function formatFireTime(d: Date): string {
  // Render the next-3 list in the user's locale time so the preview
  // matches what the user would expect for "this fires next at X".
  // The audit log + daemon-side schedule store always uses ISO/UTC.
  return d.toLocaleString();
}

export function CronPickerView(props: CronPickerViewProps) {
  const customInvalid = props.mode === "custom" && props.evaluation.status === null;
  const customNonUniform =
    props.mode === "custom" && props.evaluation.status === "non-uniform";

  return (
    <div className="space-y-3 rounded-md border border-[hsl(var(--border))] p-3">
      <fieldset className="space-y-2">
        <legend className="text-xs text-[hsl(var(--muted-foreground))]">
          Cadence
        </legend>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {CRON_PRESETS.map((p) => {
            const checkedPreset =
              props.mode === "preset" && props.preset === p.value;
            const checkedCustom = props.mode === "custom" && p.value === "custom";
            const checked = checkedPreset || checkedCustom;
            return (
              <label
                key={p.value}
                className="flex items-center gap-2 rounded-md border border-[hsl(var(--border))] px-2 py-1.5 text-xs"
                data-testid={`cron-preset-${p.value}`}
              >
                <input
                  type="radio"
                  name="cronPicker"
                  value={p.value}
                  checked={checked}
                  onChange={() => {
                    if (p.value === "custom") {
                      props.onModeChange?.("custom");
                    } else {
                      props.onModeChange?.("preset");
                      props.onPresetChange?.(p.value);
                    }
                  }}
                  className="h-3 w-3"
                />
                <span className="font-medium">{p.label}</span>
                {p.cronExpr ? (
                  <span className="ml-auto font-mono text-[10px] text-[hsl(var(--muted-foreground))]">
                    {p.cronExpr}
                  </span>
                ) : null}
              </label>
            );
          })}
        </div>
      </fieldset>

      {props.mode === "custom" ? (
        <label className="flex flex-col gap-1 text-xs">
          <span className="text-[hsl(var(--muted-foreground))]">
            Custom cron expression
          </span>
          <input
            type="text"
            name="cronExpr"
            value={props.customExpr}
            onChange={(e) => props.onCustomExprChange?.(e.target.value)}
            placeholder="e.g. */15 * * * *"
            data-testid="cron-custom-input"
            aria-invalid={customInvalid || customNonUniform || undefined}
            className={
              "h-9 rounded-md border bg-[hsl(var(--background))] px-2 font-mono text-sm " +
              (customInvalid
                ? "border-red-500/60"
                : customNonUniform
                ? "border-amber-500/60"
                : "border-[hsl(var(--border))]")
            }
          />
        </label>
      ) : null}

      {props.humanLabel !== null ? (
        <p
          className="text-xs text-[hsl(var(--foreground))]"
          data-testid="cron-human-label"
        >
          {props.humanLabel}
        </p>
      ) : null}

      {props.evaluation.message !== null ? (
        <p
          className={
            "text-[10px] " +
            (props.evaluation.status === null
              ? "text-red-400"
              : "text-amber-300")
          }
          data-testid="cron-eval-message"
        >
          {props.evaluation.message}
        </p>
      ) : null}

      {props.evaluation.nextFires.length > 0 ? (
        <div className="space-y-1">
          <p className="text-[10px] uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
            Next fires
          </p>
          <ul
            className="space-y-0.5 font-mono text-[11px]"
            data-testid="cron-next-fires"
          >
            {props.evaluation.nextFires.map((d, i) => (
              <li key={`${i}-${d.toISOString()}`}>{formatFireTime(d)}</li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

export interface CronPickerProps {
  initialMode?: CronPickerMode;
  initialPreset?: CronPickerPresetValue;
  initialCustomExpr?: string;
  /**
   * Pre-computed `now` for deterministic tests. Production callers
   * omit this — the wrapper captures `new Date()` once on mount and
   * holds it stable across keystrokes (the next-3 preview shouldn't
   * jitter while the user types).
   */
  now?: Date;
  onChange?: (state: CronPickerOnChange) => void;
}

function humanLabelFor(expr: string): string | null {
  if (expr.trim().length === 0) return null;
  try {
    return cronstrue.toString(expr.trim(), { use24HourTimeFormat: false });
  } catch {
    return null;
  }
}

export function CronPicker(props: CronPickerProps) {
  const [mode, setMode] = useState<CronPickerMode>(props.initialMode ?? "preset");
  const [preset, setPreset] = useState<CronPickerPresetValue>(
    props.initialPreset ?? "hourly",
  );
  const [customExpr, setCustomExpr] = useState(props.initialCustomExpr ?? "");

  // Stable `now` per mount: tests inject; production captures once on
  // mount so the next-3 preview reads against a single instant. If a
  // user leaves the dialog open for hours, the preview drifts — that's
  // acceptable for a creation flow.
  const now = useMemo(() => props.now ?? new Date(), [props.now]);

  const activeExpr =
    mode === "preset"
      ? CRON_PRESETS.find((p) => p.value === preset)?.cronExpr ?? ""
      : customExpr;

  const evaluation = useMemo(
    () => evaluateCron(activeExpr, now),
    [activeExpr, now],
  );

  const humanLabel = useMemo(() => humanLabelFor(activeExpr), [activeExpr]);

  const valid = evaluation.status === "ok";

  const onChange = props.onChange;
  useEffect(() => {
    if (onChange === undefined) return;
    onChange({
      cronExpr: activeExpr.trim().length > 0 ? activeExpr.trim() : null,
      intervalMinutes: evaluation.intervalMinutes,
      valid,
      message: evaluation.message,
      nextFires: evaluation.nextFires.map((d) => d.toISOString()),
    });
    // `evaluation` is derived purely from `activeExpr` + `now`; emitting
    // on those two also covers the derived fields. Keep the dep list
    // minimal so we don't bounce `onChange` on identity-changing
    // evaluation objects.
  }, [activeExpr, evaluation, valid, onChange]);

  return (
    <CronPickerView
      mode={mode}
      preset={preset}
      customExpr={customExpr}
      evaluation={evaluation}
      humanLabel={humanLabel}
      onModeChange={setMode}
      onPresetChange={setPreset}
      onCustomExprChange={setCustomExpr}
    />
  );
}
