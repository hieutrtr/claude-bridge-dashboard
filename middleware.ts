import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, readAuthEnv, verifySession } from "@/src/lib/auth";

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

  return NextResponse.next();
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
