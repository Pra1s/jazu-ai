"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { shouldRedirectGuestToHome } from "@/lib/route-access";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Гард кабинетных страниц для гостей.
 *
 * Дополняет middleware на стороне клиента: SPA-навигация, logout и
 * истечение сессии без F5. Неавторизованного на /chats, /settings,
 * /billing, /auth/phone уводим на главную. Воронку не трогаем.
 *
 * Источник правды — useAuthStatus (Session.userId через /auth/me).
 * Пока статус null на «закрытом» пути — показываем заглушку, чтобы не
 * мелькнули чужие настройки/чаты.
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
