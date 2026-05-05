import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/src/lib/auth";
import { CSRF_COOKIE } from "@/src/lib/csrf";
import { csrfGuard } from "@/src/server/csrf-guard";

export async function POST(req: Request): Promise<Response> {
  const blocked = await csrfGuard(req);
  if (blocked) return blocked;

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
