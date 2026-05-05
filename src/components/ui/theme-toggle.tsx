"use client";

import * as React from "react";
import { useTheme } from "next-themes";
import { Button } from "@/src/components/ui/button";

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const current = theme === "system" ? resolvedTheme : theme;
  const next = current === "dark" ? "light" : "dark";
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
