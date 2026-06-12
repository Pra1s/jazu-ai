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
  Headset,
  MessageCircle
} from "lucide-react";
import { cn } from "@/lib/cn";
import SidebarUserMenu from "@/components/sidebar-user-menu";
import { useAuthStatus } from "@/lib/use-auth-status";
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

const SUPPORT_WHATSAPP_PHONE = "77770957126";
const SUPPORT_WHATSAPP_PREFILL = "Здравствуйте! Пишу по платформе Jazu — нужна помощь.";
const SUPPORT_WHATSAPP_URL = `https://wa.me/${SUPPORT_WHATSAPP_PHONE}?text=${encodeURIComponent(
  SUPPORT_WHATSAPP_PREFILL
)}`;

function SidebarSupportLink() {
  const [open, setOpen] = useState(false);

  return (
    <div className="p-2 pb-0">
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Связаться с Jazu"
        className="flex w-full items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
      >
        <Headset className="h-4 w-4 shrink-0" aria-hidden="true" />
        Связаться с Jazu
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <div className="mb-1 flex h-11 w-11 items-center justify-center rounded-xl bg-secondary text-foreground">
              <Headset className="h-5 w-5" aria-hidden="true" />
            </div>
            <DialogTitle>Нужна помощь?</DialogTitle>
            <DialogDescription>
              Есть вопросы по подключению или настройке? Напишите нам — поможем настроить всё.
            </DialogDescription>
          </DialogHeader>

          <Button asChild size="lg" className="w-full">
            <a href={SUPPORT_WHATSAPP_URL} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-4 w-4" aria-hidden="true" />
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
