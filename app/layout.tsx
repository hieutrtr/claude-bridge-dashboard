import type { ReactNode } from "react";
import { cookies } from "next/headers";

import "./globals.css";
import { ThemeProvider } from "@/src/components/theme-provider";
import { Sidebar } from "@/src/components/sidebar";
import { Topbar } from "@/src/components/topbar";
import { SESSION_COOKIE, readAuthEnv, verifySession } from "@/src/lib/auth";

export const metadata = {
  title: "Claude Bridge Dashboard",
  description: "Observe agents, tasks, loops, schedules, and cost.",
};

async function isAuthed(): Promise<boolean> {
  const env = readAuthEnv();
  if (!env.secret) return false;
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  try {
    return (await verifySession(token, env.secret)) !== null;
  } catch {
    return false;
  }
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const authed = await isAuthed();
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
            </div>
          ) : (
            <main className="min-h-screen">{children}</main>
          )}
        </ThemeProvider>
      </body>
    </html>
  );
}
