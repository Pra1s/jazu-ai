"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Home,
  LayoutDashboard,
  MessageSquare,
  Smartphone,
  Settings,
  Zap,
  PanelLeft,
  X,
  CreditCard
} from "lucide-react";
import { cn } from "@/lib/cn";
import SidebarUserMenu from "@/components/sidebar-user-menu";
import { useAuthStatus } from "@/lib/use-auth-status";

const navItems = [
  { href: "/", icon: Home, label: "Главная", hideWhenAuthed: true },
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/chats", icon: MessageSquare, label: "Диалоги" },
  { href: "/whatsapp", icon: Smartphone, label: "WhatsApp" },
  { href: "/settings", icon: Settings, label: "Настройки" },
  { href: "/billing", icon: CreditCard, label: "Тарифы" }
];

function NavList({
  pathname,
  isAuthed,
  needsPhone,
  onNavigate
}: {
  pathname: string;
  isAuthed: boolean;
  needsPhone: boolean;
  onNavigate?: () => void;
}) {
  // Если залогиненный юзер ещё не ввёл телефон — навигация по сайту
  // запрещена. Сайдбар в этом состоянии не должен предлагать никаких
  // переходов: показываем небольшую подсказку вместо списка.
  if (needsPhone) {
    return (
      <div className="px-3 pt-4 text-xs leading-5 text-muted-foreground">
        Заполните номер телефона, чтобы продолжить пользоваться Jazu.
      </div>
    );
  }
  const items = navItems.filter((item) => !(item.hideWhenAuthed && isAuthed));
  return (
    <nav className="flex flex-col gap-0.5 p-2 pt-3">
      {items.map(({ href, icon: Icon, label }) => {
        const active = pathname === href || (href !== "/" && pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            {...(onNavigate ? { onClick: onNavigate } : {})}
            className={cn(
              "flex items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
              active
                ? "bg-foreground text-background"
                : "text-muted-foreground hover:bg-secondary hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-foreground">
        <Zap className="h-4 w-4 text-background" />
      </div>
      <span className="text-sm font-semibold tracking-tight">Jazu</span>
    </Link>
  );
}

export function SideNav() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const authStatus = useAuthStatus();
  const isAuthed = authStatus?.ok ?? false;
  // Если у залогиненного юзера нет телефона — глобальный гард удержит его
  // на /auth/phone, а навигация должна это визуально подтверждать:
  // никаких ссылок, кроме самого требования ввести номер.
  const needsPhone = authStatus?.ok === true && authStatus.needsPhone === true;

  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  return (
    <>
      {/* Mobile top bar (< lg) — только иконка сайдбара слева. */}
      <header className="sticky top-0 z-30 flex h-12 items-center border-b border-border bg-background/95 px-3 backdrop-blur lg:hidden">
        <button
          type="button"
          aria-label={open ? "Закрыть меню" : "Открыть меню"}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="-ml-1 flex h-8 w-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
        >
          {open ? <X className="h-4 w-4" /> : <PanelLeft className="h-4 w-4" />}
        </button>
      </header>

      {/* Mobile drawer overlay */}
      {open && (
        <button
          type="button"
          aria-label="Закрыть меню"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-40 bg-foreground/30 backdrop-blur-sm lg:hidden"
        />
      )}

      {/* Mobile drawer panel */}
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-50 flex w-[260px] max-w-[80vw] flex-col border-r border-border bg-background transition-transform duration-200 lg:hidden",
          open ? "translate-x-0" : "-translate-x-full"
        )}
        aria-hidden={!open}
      >
        <div className="flex h-14 items-center justify-between border-b border-border px-4">
          <Logo />
          <button
            type="button"
            aria-label="Закрыть меню"
            onClick={() => setOpen(false)}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-foreground transition hover:bg-secondary"
          >
            <X className="h-5 w-5" />
          </button>
        </div>
        <NavList
          pathname={pathname}
          isAuthed={isAuthed}
          needsPhone={needsPhone}
          onNavigate={() => setOpen(false)}
        />
        <div className="mt-auto">
          <SidebarUserMenu />
        </div>
      </aside>

      {/* Desktop sidebar (lg+) */}
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-border bg-background lg:flex">
        <div className="flex h-14 items-center border-b border-border px-4">
          <Logo />
        </div>
        <NavList pathname={pathname} isAuthed={isAuthed} needsPhone={needsPhone} />
        <div className="mt-auto">
          <SidebarUserMenu />
        </div>
      </aside>
    </>
  );
}
