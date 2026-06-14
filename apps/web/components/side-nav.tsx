"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  MessageSquare,
  Smartphone,
  Settings,
  Zap,
  PanelLeft,
  X,
  CreditCard,
  HelpCircle,
  ArrowUpRight
} from "lucide-react";
import { cn } from "@/lib/cn";
import SidebarUserMenu from "@/components/sidebar-user-menu";
import { useAuthStatus } from "@/lib/use-auth-status";
import { SUPPORT_WHATSAPP_URL } from "@/lib/support-whatsapp";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

// «Главная» убрана из меню авторизованного — лендинг только для гостей.
const navItems = [
  { href: "/dashboard", icon: LayoutDashboard, label: "Dashboard" },
  { href: "/chats", icon: MessageSquare, label: "Диалоги" },
  { href: "/whatsapp", icon: Smartphone, label: "WhatsApp" },
  { href: "/settings", icon: Settings, label: "Настройки" },
  { href: "/billing", icon: CreditCard, label: "Тарифы" },
  { href: "/faq", icon: HelpCircle, label: "Частые вопросы" }
];

function NavList({
  pathname,
  needsPhone,
  onNavigate
}: {
  pathname: string;
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
  return (
    <nav className="flex flex-col gap-0.5 p-2 pt-3">
      {navItems.map(({ href, icon: Icon, label }) => {
        const active = pathname === href || (href !== "/" && pathname.startsWith(href));
        return (
          <Link
            key={href}
            href={href}
            data-tour={`nav-${href.slice(1)}`}
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

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}

function SidebarSupportLink() {
  const [open, setOpen] = useState(false);

  return (
    <div className="p-2 pb-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Связаться с нами"
        className="flex w-full items-center gap-1 rounded-lg px-3 py-2.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary"
      >
        Связаться с нами
        <ArrowUpRight className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-full bg-[#25D366]/10 text-[#25D366]">
              <WhatsAppIcon className="h-5 w-5" />
            </div>
            <DialogTitle>Нужна помощь?</DialogTitle>
            <DialogDescription>
              Есть вопросы по подключению или настройке? Напишите нам - поможем настроить всё.
            </DialogDescription>
          </DialogHeader>

          <Button
            asChild
            size="lg"
            className="w-full bg-[#25D366] text-white hover:bg-[#1ebe5c]"
          >
            <a href={SUPPORT_WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
              <WhatsAppIcon className="h-4 w-4" />
              Написать в WhatsApp
            </a>
          </Button>
        </DialogContent>
      </Dialog>
    </div>
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
  // Если у залогиненного юзера нет телефона — глобальный гард удержит его
  // на /auth/phone, а навигация должна это визуально подтверждать:
  // никаких ссылок, кроме самого требования ввести номер.
  const needsPhone = authStatus?.ok === true && authStatus.needsPhone === true;

  // Форс-открытие шторки обзорным туром (OnboardingTour шлёт jazu:openNav на
  // шагах-страницах, чтобы стрелка указывала на пункт меню). Пока флаг
  // активен, шторку не закрываем по навигации между шагами и по тапу мимо.
  const forcedOpenRef = useRef(false);

  useEffect(() => {
    const openNav = () => {
      // На десктопе мобильная шторка скрыта (lg:hidden) — открывать её незачем
      // (пункты меню и так видны в постоянном сайдбаре).
      if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
        forcedOpenRef.current = true;
        setOpen(true);
      }
    };
    const closeNav = () => {
      forcedOpenRef.current = false;
      setOpen(false);
    };
    window.addEventListener("jazu:openNav", openNav);
    window.addEventListener("jazu:closeNav", closeNav);
    return () => {
      window.removeEventListener("jazu:openNav", openNav);
      window.removeEventListener("jazu:closeNav", closeNav);
    };
  }, []);

  useEffect(() => {
    // Во время тура (форс-открытие) не закрываем шторку на смене страницы —
    // иначе при авто-переходе между шагами она схлопывалась бы.
    if (forcedOpenRef.current) return;
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
          onClick={() => {
            // Во время тура тап по затемнению не закрывает шторку.
            if (forcedOpenRef.current) return;
            setOpen(false);
          }}
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
          needsPhone={needsPhone}
          onNavigate={() => setOpen(false)}
        />
        <div className="mt-auto">
          <SidebarSupportLink />
          <SidebarUserMenu />
        </div>
      </aside>

      {/* Desktop sidebar (lg+) */}
      <aside className="hidden w-[220px] shrink-0 flex-col border-r border-border bg-background lg:flex">
        <div className="flex h-14 items-center border-b border-border px-4">
          <Logo />
        </div>
        <NavList pathname={pathname} needsPhone={needsPhone} />
        <div className="mt-auto">
          <SidebarSupportLink />
          <SidebarUserMenu />
        </div>
      </aside>
    </>
  );
}
