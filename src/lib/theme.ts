// T12 — pure helper for picking the next theme from the current one.
// Extracted from <ThemeToggle> so the click logic is unit-testable
// without dragging next-themes' React hook into a JSDOM environment.

export type Theme = "dark" | "light";

export function nextTheme(
  current: string | null | undefined,
  resolvedTheme?: string | null,
): Theme {
  if (current === "dark") return "light";
  if (current === "light") return "dark";
  if (current === "system") {
    if (resolvedTheme === "dark") return "light";
    if (resolvedTheme === "light") return "dark";
  }
  return "dark";
}
