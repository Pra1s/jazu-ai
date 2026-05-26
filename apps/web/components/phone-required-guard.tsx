"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Глобальный гард обязательного телефона.
 *
 * Логика:
 *  - До завершения первой проверки /auth/me не блокируем UI: показываем
 *    children (часть страниц публична — `/`, `/auth`, маркетинг).
 *  - Если юзер залогинен и `needsPhone === true`, и сейчас он НЕ на
 *    /auth/phone — рендерим заглушку «перенаправляем…» и пушим на
 *    /auth/phone. Это значит, что выйти со страницы ввода номера никак
 *    нельзя, пока номер не сохранён.
 *  - Источник правды — общий useAuthStatus, чтобы login/logout/смена
 *    телефона из любого места приложения сразу отражались на гарде.
 */
const PUBLIC_NO_PHONE_PATHS = new Set<string>([
  "/auth/phone"
]);

export default function PhoneRequiredGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const authStatus = useAuthStatus();

  const needsPhone =
    authStatus?.ok === true && authStatus.needsPhone === true;
  const blocked = needsPhone && !PUBLIC_NO_PHONE_PATHS.has(pathname);

  useEffect(() => {
    if (!blocked) return;
    router.replace("/auth/phone");
  }, [blocked, router]);

  if (blocked) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4 text-sm text-muted-foreground">
        Перенаправляем на ввод номера…
      </div>
    );
  }

  return <>{children}</>;
}
