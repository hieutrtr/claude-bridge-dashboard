// P3-T6 — `<CronPickerView>` view-only markup tests. Same shape as
// `tests/app/loop-start-dialog.test.ts`: pure `renderToStaticMarkup`
// — no DOM, no useState. The interactive `<CronPicker>` wrapper is
// driven by Playwright (Phase 3 step 11).

import { describe, it, expect } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CronPickerView,
  type CronPickerViewProps,
} from "../../src/components/cron-picker";
import { evaluateCron } from "../../src/lib/schedule-add-client";

const NOW = new Date("2026-05-06T08:00:00.000Z");

function baseProps(
  overrides: Partial<CronPickerViewProps> = {},
): CronPickerViewProps {
  return {
    mode: "preset",
    preset: "hourly",
    customExpr: "",
    evaluation: evaluateCron("0 * * * *", NOW),
    humanLabel: "At 0 minutes past the hour",
    ...overrides,
  };
}

describe("<CronPickerView>", () => {
  it("renders all four preset radios with the cron expression label", () => {
    const html = renderToStaticMarkup(CronPickerView(baseProps()));
    expect(html).toContain('data-testid="cron-preset-hourly"');
    expect(html).toContain('data-testid="cron-preset-daily-9am"');
    expect(html).toContain('data-testid="cron-preset-weekly-mon-9am"');
    expect(html).toContain('data-testid="cron-preset-custom"');
    // Cron expressions surface as monospace labels next to the preset.
    expect(html).toContain("0 * * * *");
    expect(html).toContain("0 9 * * *");
    expect(html).toContain("0 9 * * 1");
  });

  it("preset hourly checked → only the hourly radio carries `checked`", () => {
    const html = renderToStaticMarkup(
      CronPickerView(baseProps({ mode: "preset", preset: "hourly" })),
    );
    // Hourly radio is checked.
    const hourlyInput = html.match(/<input[^>]*value="hourly"[^>]*\/>/)![0];
    expect(hourlyInput).toContain("checked");
    // Custom radio is NOT checked.
    const customInput = html.match(/<input[^>]*value="custom"[^>]*\/>/)![0];
    expect(customInput).not.toContain("checked");
  });

  it("custom mode renders the raw expression input", () => {
    const html = renderToStaticMarkup(
      CronPickerView(
        baseProps({
          mode: "custom",
          customExpr: "*/15 * * * *",
          evaluation: evaluateCron("*/15 * * * *", NOW),
          humanLabel: null,
        }),
      ),
    );
    expect(html).toContain('data-testid="cron-custom-input"');
    expect(html).toMatch(/value="\*\/15 \* \* \* \*"/);
    // Custom radio carries `checked` in custom mode.
    const customInput = html.match(/<input[^>]*value="custom"[^>]*\/>/)![0];
    expect(customInput).toContain("checked");
  });

  it("custom-mode invalid expression → red border + parse-error message", () => {
    const html = renderToStaticMarkup(
      CronPickerView(
        baseProps({
          mode: "custom",
          customExpr: "not a cron",
          evaluation: evaluateCron("not a cron", NOW),
          humanLabel: null,
        }),
      ),
    );
    // Red border class on the input.
    const customInput = html.match(/<input[^>]*data-testid="cron-custom-input"[^>]*\/>/)![0];
    expect(customInput).toContain("border-red-500");
    expect(customInput).toContain('aria-invalid="true"');
    // Eval message rendered with the red text class.
    expect(html).toContain('data-testid="cron-eval-message"');
    const evalMsg = html.match(/<p[^>]*data-testid="cron-eval-message"[^>]*>/)![0];
    expect(evalMsg).toContain("text-red-400");
  });

  it("custom-mode non-uniform expression → amber border + warning message", () => {
    const html = renderToStaticMarkup(
      CronPickerView(
        baseProps({
          mode: "custom",
          customExpr: "0 9 * * 1-5",
          evaluation: evaluateCron("0 9 * * 1-5", NOW),
          humanLabel: "At 09:00 AM, Monday through Friday",
        }),
      ),
    );
    // Amber border on the input.
    const customInput = html.match(/<input[^>]*data-testid="cron-custom-input"[^>]*\/>/)![0];
    expect(customInput).toContain("border-amber-500");
    // Eval message rendered amber.
    const evalMsg = html.match(/<p[^>]*data-testid="cron-eval-message"[^>]*>/)![0];
    expect(evalMsg).toContain("text-amber-300");
    expect(html).toMatch(/uniform/i);
  });

  it("preset mode uniform expression renders human label + 3 fire times", () => {
    const html = renderToStaticMarkup(
      CronPickerView(
        baseProps({
          mode: "preset",
          preset: "hourly",
          evaluation: evaluateCron("0 * * * *", NOW),
          humanLabel: "At 0 minutes past the hour",
        }),
      ),
    );
    // Human label renders.
    expect(html).toContain('data-testid="cron-human-label"');
    expect(html).toContain("At 0 minutes past the hour");
    // Next-fires list with 3 entries.
    expect(html).toContain('data-testid="cron-next-fires"');
    const liCount = (html.match(/<li[^>]*>/g) ?? []).length;
    expect(liCount).toBeGreaterThanOrEqual(3);
  });

  it("invalid eval → no next-fires list rendered", () => {
    const html = renderToStaticMarkup(
      CronPickerView(
        baseProps({
          mode: "custom",
          customExpr: "not a cron",
          evaluation: evaluateCron("not a cron", NOW),
          humanLabel: null,
        }),
      ),
    );
    expect(html).not.toContain('data-testid="cron-next-fires"');
  });

  it("daily preset selected → daily radio is the checked one", () => {
    const html = renderToStaticMarkup(
      CronPickerView(
        baseProps({
          preset: "daily-9am",
          evaluation: evaluateCron("0 9 * * *", NOW),
        }),
      ),
    );
    const dailyInput = html.match(/<input[^>]*value="daily-9am"[^>]*\/>/)![0];
    expect(dailyInput).toContain("checked");
    const hourlyInput = html.match(/<input[^>]*value="hourly"[^>]*\/>/)![0];
    expect(hourlyInput).not.toContain("checked");
  });

  it("preset mode does NOT render the custom expression input", () => {
    const html = renderToStaticMarkup(CronPickerView(baseProps()));
    expect(html).not.toContain('data-testid="cron-custom-input"');
  });

  it("humanLabel=null → human-label paragraph is omitted", () => {
    const html = renderToStaticMarkup(
      CronPickerView(baseProps({ humanLabel: null })),
    );
    expect(html).not.toContain('data-testid="cron-human-label"');
  });

  it("ok evaluation → no eval-message paragraph rendered", () => {
    const html = renderToStaticMarkup(
      CronPickerView(
        baseProps({
          mode: "preset",
          preset: "hourly",
          evaluation: evaluateCron("0 * * * *", NOW),
        }),
      ),
    );
    expect(html).not.toContain('data-testid="cron-eval-message"');
  });
});
