// P4-T07 — Pure helpers for the mobile nav drawer. Extracted so the
// open/close + body-scroll lock + auto-close-on-route-change behaviour
// can be unit-tested in Bun without a DOM.

/** Tailwind breakpoint (md) at which the desktop sidebar becomes visible. */
export const MOBILE_BREAKPOINT_PX = 768;

/** Whether the viewport width should treat the drawer as the active nav. */
export function isMobileViewport(width: number): boolean {
  if (!Number.isFinite(width) || width <= 0) return true;
  return width < MOBILE_BREAKPOINT_PX;
}

/**
 * The drawer auto-closes on route change so the next page is reachable
 * without a second tap. Returns `true` when the previously open drawer
 * should close because the path differs.
 */
export function shouldCloseOnPathChange(
  previousPath: string | null,
  nextPath: string | null,
  open: boolean,
): boolean {
  if (!open) return false;
  if (previousPath === null) return false;
  if (nextPath === null) return false;
  return previousPath !== nextPath;
}

/**
 * Touch-target rule for WCAG 2.5.5 AAA / Apple HIG (44×44 px). Buttons
 * at sizes below this fail the T07 acceptance check; the helper is used
 * by the unit test that audits every Tailwind utility used on
 * interactive elements in the mobile drawer.
 */
export const MIN_TOUCH_TARGET_PX = 44;

/**
 * Returns true when the height utility carries at least 44px. Tailwind
 * units are in `0.25rem` increments (rem = 16px). `h-11` = 44px, `h-12`
 * = 48px, `h-auto` is opt-out (caller must verify content height).
 */
export function meetsTouchTarget(heightUtil: string): boolean {
  if (heightUtil === "h-auto") return true;
  const m = heightUtil.match(/^h-(\d+(?:\.\d+)?)$/);
  if (!m) return false;
  const units = Number(m[1]);
  if (!Number.isFinite(units)) return false;
  const px = units * 4;
  return px >= MIN_TOUCH_TARGET_PX;
}
