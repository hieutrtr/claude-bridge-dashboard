import type { ReactNode } from "react";
import { cookies } from "next/headers";

import "./globals.css";
import { ThemeProvider } from "@/src/components/theme-provider";
import { PermissionRelayToast } from "@/src/components/permission-relay-toast";
import { Sidebar } from "@/src/components/sidebar";
import { Topbar } from "@/src/components/topbar";
import { CommandPalette } from "@/src/components/command-palette";
import { SESSION_COOKIE, readAuthEnv, verifySession } from "@/src/lib/auth";
import { appRouter } from "@/src/server/routers/_app";

export const metadata = {
  title: "Claude Bridge Dashboard",
  description: "Observe agents, tasks, loops, schedules, and cost.",
};

async function readSession(): Promise<{
  authed: boolean;
  role: "owner" | "member" | null;
}> {
  const env = readAuthEnv();
  if (!env.secret) return { authed: false, role: null };
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return { authed: false, role: null };
  let userId: string | null = null;
  try {
    const payload = await verifySession(token, env.secret);
    if (!payload) return { authed: false, role: null };
    userId = payload.sub;
  } catch {
    return { authed: false, role: null };
  }
  // Resolve role via the same caller surface used by `/settings/users`.
  // We tolerate a missing DB / migration in dev — fall back to owner for
  // the legacy "owner" sub so the palette still surfaces every command.
  try {
    const caller = appRouter.createCaller({ userId });
    const me = await caller.auth.me();
    if (me === null) return { authed: true, role: null };
    return { authed: true, role: me.role };
  } catch {
    return { authed: true, role: userId === "owner" ? "owner" : null };
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { authed, role } = await readSession();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem={false}
          disableTransitionOnChange
        >
          {authed ? (
            <div className="flex min-h-screen">
              <Sidebar />
              <div className="flex min-w-0 flex-1 flex-col">
                <Topbar />
                <main className="flex-1 overflow-auto p-6">{children}</main>
              </div>
              <PermissionRelayToast />
              <CommandPalette role={role} />
            </div>
          ) : (
            <main className="min-h-screen">{children}</main>
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
