"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Button } from "@/src/components/ui/button";
import { nextTheme } from "@/src/lib/theme";

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const next = nextTheme(theme, resolvedTheme);
  return (
    <Button
      variant="outline"
      size="sm"
      aria-label={`Switch to ${next} theme`}
      data-testid="theme-toggle"
      onClick={() => setTheme(next)}
    >
      {next === "dark" ? "Dark" : "Light"}
    </Button>
  );
}
