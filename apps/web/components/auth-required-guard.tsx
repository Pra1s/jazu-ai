"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { isProtectedPath } from "@/lib/route-access";
import { persistNext, sanitizeNext } from "@/lib/safe-next";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Глобальный гард входа для приватных страниц.
 *
 * Дополняет middleware: client-side навигация, logout и истечение сессии
 * без F5. Пока /auth/me не ответил — на protected path не показываем кабинет.
 */
export default function AuthRequiredGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const authStatus = useAuthStatus();

  const protectedPath = isProtectedPath(pathname);
  const loading = protectedPath && authStatus === null;
  const blocked = protectedPath && authStatus?.ok === false;

  useEffect(() => {
    if (!blocked) return;
    const next = sanitizeNext(pathname);
    persistNext(next);
    const target = next ? `/auth?next=${encodeURIComponent(next)}` : "/auth";
    router.replace(target);
  }, [blocked, pathname, router]);

  if (loading) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4 text-sm text-muted-foreground">
        Проверяем вход…
      </div>
    );
  }

  if (blocked) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4 text-sm text-muted-foreground">
        Перенаправляем на вход…
      </div>
    );
  }

  return <>{children}</>;
}
