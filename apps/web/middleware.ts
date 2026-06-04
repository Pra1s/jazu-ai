import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { shouldRedirectGuestToHome } from "@/lib/route-access";

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

  if (!shouldRedirectGuestToHome(pathname)) {
    return NextResponse.next();
  }

  if (await isAuthenticated(request)) {
    return NextResponse.next();
  }

  const url = request.nextUrl.clone();
  url.pathname = "/";
  url.search = "";
  return NextResponse.redirect(url);
}

// Next.js требует литеральный matcher (без spread/import) — держим список
// синхронным с GUEST_REDIRECT_PREFIXES в @/lib/route-access.
export const config = {
  matcher: [
    "/chats/:path*",
    "/settings/:path*",
    "/billing/:path*",
    "/auth/phone",
    "/auth/phone/:path*"
  ]
};
