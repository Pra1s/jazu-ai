"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { shouldRedirectGuestToHome } from "@/lib/route-access";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Гард кабинетных страниц для гостей (только клиент).
 *
 * Неавторизованного на /chats, /settings, /billing, /auth/phone уводим на
 * главную. Воронку не трогаем. Серверного middleware нет специально:
 * cookie сессии host-only для api-домена и на web-домен не приходит, из-за
 * чего серверная проверка редиректила бы и залогиненных.
 *
 * Источник правды — useAuthStatus (Session.userId через /auth/me, apiFetch
 * ходит на api-домен напрямую с cookie). Пока статус null на «закрытом»
 * пути — показываем заглушку, чтобы не мелькнули чужие настройки/чаты.
 */
export default function GuestRouteGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const authStatus = useAuthStatus();

  const restricted = shouldRedirectGuestToHome(pathname);
  const loading = restricted && authStatus === null;
  const blocked = restricted && authStatus?.ok === false;

  useEffect(() => {
    if (!blocked) return;
    router.replace("/");
  }, [blocked, router]);

  if (loading || blocked) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4 text-sm text-muted-foreground">
        Перенаправляем…
      </div>
    );
  }

  return <>{children}</>;
}
