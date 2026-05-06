"use client";

import { useState, type FormEvent } from "react";

import { Button } from "@/src/components/ui/button";
import { Input } from "@/src/components/ui/input";

const ERROR_COPY: Record<string, string> = {
  invalid_body: "Please enter a valid email address.",
  rate_limited: "Too many requests. Try again in a minute.",
  auth_not_configured: "Email sign-in is not configured on the server.",
};

type Mode = "idle" | "pending" | "sent";

export function MagicLinkForm() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("idle");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setMode("pending");
    try {
      const res = await fetch("/api/auth/magic-link/request", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      if (res.ok) {
        setMode("sent");
        return;
      }
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(ERROR_COPY[body.error ?? ""] ?? "Could not send magic link.");
      setMode("idle");
    } catch {
      setError("Network error. Try again.");
      setMode("idle");
    }
  }

  if (mode === "sent") {
    return (
      <div role="status" className="text-sm text-[hsl(var(--foreground))]/80">
        <p>If an account exists for that email, a one-time sign-in link is on its way.</p>
        <p className="text-xs text-[hsl(var(--foreground))]/60 pt-1">
          The link expires in 15 minutes and can be used once.
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-3">
      <Input
        type="email"
        name="email"
        autoComplete="email"
        required
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="you@example.com"
        aria-label="Email"
        disabled={mode === "pending"}
      />
      {error ? (
        <p role="alert" className="text-sm text-red-500">
          {error}
        </p>
      ) : null}
      <Button type="submit" disabled={mode === "pending" || email.length === 0}>
        {mode === "pending" ? "Sending…" : "Send magic link"}
      </Button>
    </form>
  );
}
