import type { ReactNode } from "react";
import "./globals.css";
import { ThemeProvider } from "@/src/components/theme-provider";

export const metadata = {
  title: "Claude Bridge Dashboard",
  description: "Phase 0 spike — scaffold only",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <ThemeProvider attribute="class" defaultTheme="dark" enableSystem={false}>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
