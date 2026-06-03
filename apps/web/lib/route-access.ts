/**
 * Публичные и защищённые маршруты web-приложения.
 * Используется в middleware и AuthRequiredGuard — один источник правды.
 */

/** Точное совпадение pathname (без query). */
export const PUBLIC_EXACT_PATHS = new Set(["/", "/auth", "/faq"]);

/** Префиксы полностью публичных разделов. */
export const PUBLIC_PATH_PREFIXES = ["/legal"];

/** Префиксы, требующие залогиненного пользователя (Session.userId). */
export const PROTECTED_PATH_PREFIXES = [
  "/dashboard",
  "/chats",
  "/settings",
  "/billing",
  "/whatsapp",
  "/auth/phone"
];

/** Matcher-сегменты для Next.js middleware (без статики и _next). */
export const MIDDLEWARE_MATCHER = [
  "/dashboard/:path*",
  "/chats/:path*",
  "/settings/:path*",
  "/billing/:path*",
  "/whatsapp/:path*",
  "/auth/phone",
  "/auth/phone/:path*",
  "/login"
] as const;

function matchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

export function isPublicPath(pathname: string): boolean {
  if (PUBLIC_EXACT_PATHS.has(pathname)) return true;
  for (const prefix of PUBLIC_PATH_PREFIXES) {
    if (matchesPrefix(pathname, prefix)) return true;
  }
  return false;
}

export function isProtectedPath(pathname: string): boolean {
  if (isPublicPath(pathname)) return false;
  for (const prefix of PROTECTED_PATH_PREFIXES) {
    if (matchesPrefix(pathname, prefix)) return true;
  }
  return false;
}
