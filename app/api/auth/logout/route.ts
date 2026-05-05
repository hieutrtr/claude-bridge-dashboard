import { NextResponse } from "next/server";

import { SESSION_COOKIE } from "@/src/lib/auth";

export async function POST(_req: Request): Promise<Response> {
  const res = NextResponse.json({ ok: true });
  res.cookies.set({
    name: SESSION_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return res;
}
