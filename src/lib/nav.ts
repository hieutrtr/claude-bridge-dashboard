export type NavItem = {
  // English label — kept as the i18n fallback string AND the source of
  // truth for keys that ship without a translation yet. Existing tests
  // (`tests/lib/nav.test.ts`) assert exact English strings.
  label: string;
  href: string;
  // P4-T12 — `t(i18nKey)` returns the translated label at render time;
  // missing keys fall back to `en.json`, which mirrors `label`.
  i18nKey: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Agents", href: "/agents", i18nKey: "nav.agents" },
  { label: "Tasks", href: "/tasks", i18nKey: "nav.tasks" },
  { label: "Loops", href: "/loops", i18nKey: "nav.loops" },
  { label: "Schedules", href: "/schedules", i18nKey: "nav.schedules" },
  { label: "Cost", href: "/cost", i18nKey: "nav.cost" },
  { label: "Audit", href: "/audit", i18nKey: "nav.audit" },
  { label: "Users", href: "/settings/users", i18nKey: "nav.users" },
  { label: "Notifications", href: "/settings/notifications", i18nKey: "nav.notifications" },
  { label: "Telemetry", href: "/settings/telemetry", i18nKey: "nav.telemetry" },
] as const;

export function isNavActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (pathname === href + "/") return true;
  return pathname.startsWith(href + "/");
}
