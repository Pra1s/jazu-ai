/**
 * Кабинетные страницы, недоступные гостю.
 * Используется в middleware и GuestRouteGuard — один источник правды.
 *
 * Список намеренно узкий: воронка (`/`, `/dashboard`, `/auth`, `/whatsapp`)
 * и маркетинг (`/faq`, `/legal/*`) сюда НЕ входят — гость должен спокойно
 * пройти путь «описал бизнес → /dashboard → тест → /whatsapp → вход».
 */
export const GUEST_REDIRECT_PREFIXES = [
  "/chats",
  "/settings",
  "/billing",
  "/auth/phone"
];

/** true, если неавторизованного юзера на этом пути надо увести на главную. */
export function shouldRedirectGuestToHome(pathname: string): boolean {
  return GUEST_REDIRECT_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`)
  );
}
