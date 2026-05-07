export type NavItem = {
  label: string;
  href: string;
};

export const NAV_ITEMS: readonly NavItem[] = [
  { label: "Agents", href: "/agents" },
  { label: "Tasks", href: "/tasks" },
  { label: "Loops", href: "/loops" },
  { label: "Schedules", href: "/schedules" },
  { label: "Cost", href: "/cost" },
  { label: "Audit", href: "/audit" },
  { label: "Users", href: "/settings/users" },
  { label: "Notifications", href: "/settings/notifications" },
  { label: "Telemetry", href: "/settings/telemetry" },
] as const;

export function isNavActive(pathname: string, href: string): boolean {
  if (pathname === href) return true;
  if (pathname === href + "/") return true;
  return pathname.startsWith(href + "/");
}
