"use client";

import { SideNav } from "@/components/side-nav";
import GuestHeader from "@/components/guest-header";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Каркас приложения. Решает, что показывать вокруг контента:
 *  - авторизованный юзер → боковое меню SideNav (как раньше);
 *  - гость (или пока статус ещё грузится) → верхняя шапка GuestHeader.
 *
 * Источник правды — общий useAuthStatus, чтобы login/logout сразу меняли
 * каркас без перезагрузки. Пока статус === null, считаем «как гость», но
 * GuestHeader сам прячет CTA-кнопки до загрузки, чтобы ничего не мигало.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const authStatus = useAuthStatus();
  const isAuthed = authStatus?.ok === true;

  if (isAuthed) {
    return (
      <div className="flex h-dvh flex-col lg:flex-row">
        <SideNav />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <GuestHeader />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
    </div>
  );
}
