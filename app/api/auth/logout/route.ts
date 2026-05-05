import { NextResponse } from "next/server";

import { SESSION_COOKIE, readAuthEnv, verifySession } from "@/src/lib/auth";
import { CSRF_COOKIE } from "@/src/lib/csrf";
import { csrfGuard } from "@/src/server/csrf-guard";
import { rateLimitMutations } from "@/src/server/rate-limit-mutations";

export async function POST(req: Request): Promise<Response> {
  const blocked = await csrfGuard(req);
  if (blocked) return blocked;

  const sub = await readSessionSubject(req);
  const rateBlocked = await rateLimitMutations(req, sub);
  if (rateBlocked) return rateBlocked;

  const isProd = process.env.NODE_ENV === "production";
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: isProd,
    path: "/",
    maxAge: 0,
  });
  res.cookies.set({
    name: CSRF_COOKIE,
    value: "",
    httpOnly: false,
    sameSite: "lax",
    secure: isProd,
    path: "/",
    maxAge: 0,
  });
  return res;
}

async function readSessionSubject(req: Request): Promise<string | null> {
  const { secret } = readAuthEnv();
  if (!secret) return null;
  const cookieHeader = req.headers.get("cookie");
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== SESSION_COOKIE) continue;
    const token = part.slice(eq + 1).trim();
    if (!token) return null;
    const payload = await verifySession(token, secret);
    return payload?.sub ?? null;
  }
  return null;
}
