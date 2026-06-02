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
 *    /whatsapp (или /auth/phone) — рендерим заглушку «перенаправляем…» и
 *    пушим на /whatsapp. Новый юзер сначала подключает WhatsApp, а уже
 *    после успешного подключения подтверждает личный номер для уведомлений
 *    прямо на этом экране. Пока номер не сохранён — в кабинет не пускаем.
 *    /auth/phone оставляем в whitelist как fallback (старый экран ввода).
 *  - Источник правды — общий useAuthStatus, чтобы login/logout/смена
 *    телефона из любого места приложения сразу отражались на гарде.
 */
const PUBLIC_NO_PHONE_PATHS = new Set<string>([
  "/whatsapp",
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
    router.replace("/whatsapp");
  }, [blocked, router]);

  if (blocked) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4 text-sm text-muted-foreground">
        Перенаправляем на подключение WhatsApp…
      </div>
    );
  }

  return <>{children}</>;
}
