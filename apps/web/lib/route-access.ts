/**
 * Кабинетные страницы, недоступные гостю.
 * Источник правды для клиентского GuestRouteGuard.
 *
 * Серверный middleware намеренно НЕ используется: cookie сессии host-only
 * для api-домена (api.jazu.chat), а web на другом поддомене (app.jazu.chat),
 * поэтому на web-домен cookie не приходит и серверная проверка /auth/me
 * считала бы гостями всех, включая залогиненных. Проверку делаем на клиенте
 * через useAuthStatus (apiFetch ходит на api-домен напрямую с cookie).
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

/**
 * Пути воронки и маркетинга — на них до ответа /auth/me можно показать
 * гостевую шапку. На остальных (кабинет) — нейтральный каркас, иначе
 * залогиненный при F5 на миг видит GuestHeader с «Подключить WhatsApp».
 */
export function isPublicGuestPath(pathname: string): boolean {
  if (pathname === "/" || pathname === "/auth" || pathname === "/faq") return true;
  if (pathname === "/dashboard" || pathname.startsWith("/whatsapp")) return true;
  if (pathname.startsWith("/legal")) return true;
  return false;
}
