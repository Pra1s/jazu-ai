import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { isProtectedPath } from "@/lib/route-access";
import { sanitizeNext } from "@/lib/safe-next";

const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001/api";

async function isAuthenticated(request: NextRequest): Promise<boolean> {
  const cookie = request.headers.get("cookie");
  if (!cookie) return false;

  try {
    const res = await fetch(`${API_BASE_URL}/auth/me`, {
      headers: { cookie },
      cache: "no-store"
    });
    if (!res.ok) return false;
    const data = (await res.json()) as {
      success?: boolean;
      user?: { id?: string } | null;
    };
    return Boolean(data.success && data.user?.id);
  } catch {
    return false;
  }
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Legacy: Google OAuth ошибки редиректят на /login, страницы нет.
  if (pathname === "/login") {
    const url = request.nextUrl.clone();
    url.pathname = "/auth";
    return NextResponse.redirect(url);
  }

  if (!isProtectedPath(pathname)) {
    return NextResponse.next();
  }

  if (await isAuthenticated(request)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/auth";
  url.search = "";
  const next = sanitizeNext(pathname);
  if (next) url.searchParams.set("next", next);
  return NextResponse.redirect(url);
}

// Next.js требует литеральный matcher (без spread/import) — дублируем route-access.
export const config = {
  matcher: [
    "/dashboard/:path*",
    "/chats/:path*",
    "/settings/:path*",
    "/billing/:path*",
    "/whatsapp/:path*",
    "/auth/phone",
    "/auth/phone/:path*",
    "/login"
  ]
};
