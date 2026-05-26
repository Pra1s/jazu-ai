"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api";

/**
 * Глобальный гард обязательного телефона.
 *
 * Поведение:
 *  - Дёргает /auth/me один раз на маунте (и при каждом изменении pathname,
 *    чтобы реагировать на логин/логаут без полного перезагруза).
 *  - Если юзер залогинен и у него нет phone:
 *      • если он уже на /auth/phone — пропускаем children как есть;
 *      • иначе — НЕ рендерим children и сразу редиректим на /auth/phone.
 *  - Если юзер не залогинен / залогинен с телефоном — рендерим children.
 *
 * Важно: до завершения первой проверки мы не блокируем UI целиком, потому
 * что часть страниц публична (например / и /auth). Вместо этого блокируем
 * только сценарий «залогинен без телефона на чужой странице».
 */
const PUBLIC_NO_PHONE_PATHS = new Set<string>([
  "/auth/phone"
]);

type MeResponse = {
  success: boolean;
  needsPhone?: boolean;
};

type Status = "loading" | "ok" | "needs-phone" | "anon";

export default function PhoneRequiredGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const [status, setStatus] = useState<Status>("loading");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    void (async () => {
      try {
        const res = await apiFetch("/auth/me", { method: "GET" });
        if (cancelled) return;
        if (res.status === 401) {
          setStatus("anon");
          return;
        }
        const data = (await res.json()) as MeResponse;
        if (cancelled) return;
        if (data.success && data.needsPhone) {
          setStatus("needs-phone");
        } else {
          setStatus("ok");
        }
      } catch {
        if (!cancelled) setStatus("anon");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [pathname]);

  useEffect(() => {
    if (status !== "needs-phone") return;
    if (PUBLIC_NO_PHONE_PATHS.has(pathname)) return;
    router.replace("/auth/phone");
  }, [status, pathname, router]);

  // Залогинен без телефона на запрещённой странице — рисуем заглушку, чтобы
  // юзер не видел контент в момент редиректа.
  if (status === "needs-phone" && !PUBLIC_NO_PHONE_PATHS.has(pathname)) {
    return (
      <div className="grid min-h-[60vh] place-items-center px-4 text-sm text-muted-foreground">
        Перенаправляем на ввод номера…
      </div>
    );
  }

  return <>{children}</>;
}
