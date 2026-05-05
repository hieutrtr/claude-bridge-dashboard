import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, SESSION_TTL_SECONDS, readAuthEnv, verifySession } from "@/src/lib/auth";
import { CSRF_COOKIE, issueCsrfToken } from "@/src/lib/csrf";

const PUBLIC_EXACT = new Set(["/login", "/api/auth/login", "/api/auth/logout"]);

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_EXACT.has(pathname)) {
    return NextResponse.next();
  }

  const env = readAuthEnv();
  if (!env.password || !env.secret) {
    return redirectToLogin(req);
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) {
    return redirectToLogin(req);
  }

  const payload = await verifySession(token, env.secret);
  if (!payload) {
    return redirectToLogin(req);
  }

  // Backfill: an authenticated request that does not yet carry a CSRF
  // cookie (e.g. a session created before T08 deployed, or a session
  // that lost the cookie via a prior logout) gets one issued lazily
  // here. The cookie is non-HttpOnly so client JS can read it for the
  // x-csrf-token header on mutations. See ADR 0001.
  const res = NextResponse.next();
  if (!req.cookies.get(CSRF_COOKIE)?.value) {
    const csrfToken = await issueCsrfToken(env.secret);
    res.cookies.set({
      name: CSRF_COOKIE,
      value: csrfToken,
      httpOnly: false,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: SESSION_TTL_SECONDS,
    });
  }
  return res;
}

function redirectToLogin(req: NextRequest) {
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  const next = `${req.nextUrl.pathname}${req.nextUrl.search}`;
  if (next !== "/login" && next !== "/") {
    url.searchParams.set("next", next);
  }
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
