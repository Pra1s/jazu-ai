"use client";

import { usePathname } from "next/navigation";
import { SideNav } from "@/components/side-nav";
import GuestHeader from "@/components/guest-header";
import SubscriptionBanner from "@/components/subscription-banner";
import OnboardingTour from "@/components/onboarding-tour";
import GuestTour from "@/components/guest-tour";
import { isPublicGuestPath } from "@/lib/route-access";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Каркас приложения. Решает, что показывать вокруг контента:
 *  - авторизованный юзер → боковое меню SideNav (как раньше);
 *  - гость → верхняя шапка GuestHeader;
 *  - пока /auth/me грузится на кабинетных страницах → нейтральный каркас
 *    без шапки (иначе залогиненный при F5 мигал бы гостевой GuestHeader).
 *
 * Источник правды — общий useAuthStatus, чтобы login/logout сразу меняли
 * каркас без перезагрузки.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const authStatus = useAuthStatus();
  const isAuthed = authStatus?.ok === true;
  const authLoading = authStatus === null;

  // Кабинет (/chats, /settings, …): ждём auth, не показываем гостевую шапку.
  if (authLoading && !isPublicGuestPath(pathname)) {
    return (
      <div className="flex h-dvh flex-col">
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          {children}
        </main>
      </div>
    );
  }

  if (isAuthed) {
    return (
      <div className="flex h-dvh flex-col lg:flex-row">
        <SideNav />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <SubscriptionBanner />
          {children}
        </main>
        <OnboardingTour />
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <GuestHeader />
      <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {children}
      </main>
      <GuestTour />
    </div>
  );
}
