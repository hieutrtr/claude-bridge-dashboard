import { NextResponse } from "next/server";
import { z } from "zod";

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  readAuthEnv,
  signSession,
  timingSafeEqual,
} from "@/src/lib/auth";

const Body = z.object({ password: z.string().min(1) });

export async function POST(req: Request): Promise<Response> {
  const env = readAuthEnv();
  if (!env.password || !env.secret) {
    return NextResponse.json({ error: "auth_not_configured" }, { status: 503 });
  }

  let json: unknown = null;
  try {
    json = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = Body.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!timingSafeEqual(parsed.data.password, env.password)) {
    return NextResponse.json({ error: "invalid_password" }, { status: 401 });
  }

  const token = await signSession(env.secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: token,
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
  return res;
}
