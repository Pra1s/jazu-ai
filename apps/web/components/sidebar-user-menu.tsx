"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { LogIn, LogOut, ChevronUp, UserCircle, CreditCard, Zap } from "lucide-react";
import { apiFetch, apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { resetAuthStatus, subscribeAuthStatus } from "@/lib/use-auth-status";

type UsageView = {
  total: number;
  used: number;
  remaining: number;
  exhausted: boolean;
  trialActive: boolean;
  periodKey: string;
};

type Me = {
  success: boolean;
  user?: {
    id: string;
    email: string;
    name?: string | null;
    phone?: string | null;
    avatarUrl?: string | null;
    googleId?: string | null;
  };
  needsPhone?: boolean;
  usage?: UsageView | null;
};

function fmt(n: number) {
  return n.toLocaleString("ru-RU");
}

function initialsFromEmail(email: string): string {
  const local = email.split("@")[0] ?? "";
  const parts = local.split(/[._-]/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  }
  return (local.slice(0, 2) || "U").toUpperCase();
}

function Avatar({ url, label }: { url?: string | null; label: string }) {
  if (url) {
    return (
      // eslint-disable-next-line @next/next/no-img-element -- внешний URL, без оптимизации
      <img
        src={url}
        alt={label}
        className="h-8 w-8 rounded-full border border-border object-cover"
        referrerPolicy="no-referrer"
      />
    );
  }
  return (
    <div className="flex h-8 w-8 items-center justify-center rounded-full bg-secondary text-[11px] font-semibold uppercase text-foreground">
      {label}
    </div>
  );
}

export default function SidebarUserMenu({ collapsed = false }: { collapsed?: boolean }) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [usage, setUsage] = useState<UsageView | null>(null);
  const [busy, setBusy] = useState(false);

  const loadMe = useCallback(async () => {
    try {
      const res = await apiFetch("/auth/me", { method: "GET" });
      if (res.status === 401) {
        setMe({ success: false });
        setUsage(null);
        return;
      }
      const data = (await res.json()) as Me;
      setMe(data);
      setUsage(data.usage ?? null);
    } catch {
      setMe({ success: false });
      setUsage(null);
    }
  }, []);

  useEffect(() => {
    // Перезагружаем /auth/me каждый раз, когда меняется глобальный
    // auth-status: логин по коду / Google / logout / смена телефона.
    // Без этой подписки карточка пользователя обновлялась бы только
    // после полного reload страницы (loadMe раньше вызывался один раз
    // на маунте).
    const unsubscribe = subscribeAuthStatus(() => {
      void loadMe();
    });
    return unsubscribe;
  }, [loadMe]);

  useEffect(() => {
    let cancelled = false;
    async function pollUsage() {
      try {
        const res = await apiFetch("/billing/me", { method: "GET" });
        if (cancelled || !res.ok) return;
        const data = (await res.json()) as { ok: boolean; usage?: UsageView };
        if (data.ok && data.usage) setUsage(data.usage);
      } catch {
        // тихо — следующий poll попробует снова
      }
    }
    // Real-time через polling каждые 15с. Достаточно отзывчиво и не
    // нагружает API на десятках открытых вкладок.
    const timer = setInterval(() => {
      void pollUsage();
    }, 15_000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  async function logout() {
    if (busy) return;
    setBusy(true);
    try {
      await apiJson("/auth/logout", { method: "POST" });
    } catch {
      // даже если /logout сбойнул — продолжим на UI
    } finally {
      setBusy(false);
    }
    // Локальный state у этого компонента не пересчитается сам после
    // logout (loadMe вызывался один раз на маунте), поэтому без явного
    // сброса карточка пользователя продолжает висеть до hard reload.
    setMe({ success: false });
    setUsage(null);
    // Сбросим кэш авторизации, чтобы SideNav сразу показал «Главная».
    resetAuthStatus();
    router.replace("/");
    router.refresh();
  }

  // Loading state — узкая полоска, чтобы не дёргался layout.
  if (me === null) {
    return (
      <div className="border-t border-border p-3">
        <div className="h-10 animate-pulse rounded-lg bg-secondary/60" />
      </div>
    );
  }

  // Анонимный пользователь — CTA «Войти».
  if (!me.success || !me.user) {
    return (
      <div className="border-t border-border p-3">
        <Link
          href="/auth"
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-border bg-background px-3 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-secondary",
            collapsed && "justify-center"
          )}
        >
          <LogIn className="h-4 w-4 shrink-0" />
          {!collapsed && <span>Войти</span>}
        </Link>
        {!collapsed && (
          <p className="mt-2 px-1 text-[11px] leading-tight text-muted-foreground">
            Без входа агент привязан только к этой сессии браузера.
          </p>
        )}
      </div>
    );
  }

  const user = me.user;
  const label = initialsFromEmail(user.email);
  const displayName = user.name?.trim() || user.email.split("@")[0] || user.email;

  const usagePct = usage ? Math.min(100, (usage.used / Math.max(1, usage.total)) * 100) : 0;
  const showQuotaInline = !collapsed && usage !== null;

  return (
    <div className="border-t border-border p-2">
      {/* Виджет квоты — над user-меню. Прогресс-бар + клик ведёт в /billing. */}
      {showQuotaInline && (
        <Link
          href="/billing"
          className="mb-2 block rounded-lg border border-border bg-background px-2.5 py-2 transition-colors hover:bg-secondary"
          aria-label="Перейти к тарифам"
        >
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="flex items-center gap-1.5 font-medium text-foreground">
              <Zap className={cn("h-3 w-3", usage.exhausted ? "text-destructive" : "text-foreground")} />
              Диалоги
            </span>
            <span
              className={cn(
                "tabular-nums",
                usage.exhausted ? "text-destructive font-semibold" : "text-muted-foreground"
              )}
            >
              {fmt(usage.remaining)} / {fmt(usage.total)}
            </span>
          </div>
          <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-secondary">
            <div
              className={cn(
                "h-full rounded-full transition-all",
                usage.exhausted ? "bg-destructive" : usagePct > 80 ? "bg-amber-500" : "bg-foreground"
              )}
              style={{ width: `${usagePct}%` }}
            />
          </div>
        </Link>
      )}
      <DropdownMenu.Root>
        <DropdownMenu.Trigger asChild>
          <button
            type="button"
            className={cn(
              "group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-secondary focus:bg-secondary focus:outline-none",
              collapsed && "justify-center"
            )}
            aria-label="Меню пользователя"
          >
            <Avatar url={user.avatarUrl ?? null} label={label} />
            {!collapsed && (
              <>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-foreground">
                    {displayName}
                  </div>
                  <div className="truncate text-[11px] text-muted-foreground">
                    {user.email}
                  </div>
                </div>
                <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-180" />
              </>
            )}
          </button>
        </DropdownMenu.Trigger>

        <DropdownMenu.Portal>
          <DropdownMenu.Content
            side="top"
            align="start"
            sideOffset={8}
            className="z-50 min-w-[220px] rounded-xl border border-border bg-card p-1 text-foreground shadow-lg"
          >
            <div className="px-3 py-2">
              <div className="truncate text-sm font-medium text-foreground">
                {displayName}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {user.email}
              </div>
              {user.phone && (
                <div className="mt-0.5 truncate text-xs text-muted-foreground">
                  {user.phone}
                </div>
              )}
            </div>

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <DropdownMenu.Item asChild>
              <Link
                href="/settings"
                className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-foreground outline-none focus:bg-secondary"
              >
                <UserCircle className="h-4 w-4" />
                Профиль и настройки
              </Link>
            </DropdownMenu.Item>

            <DropdownMenu.Item asChild>
              <Link
                href="/billing"
                className="flex cursor-pointer items-center justify-between gap-2 rounded-md px-3 py-2 text-sm text-foreground outline-none focus:bg-secondary"
              >
                <span className="flex items-center gap-2">
                  <CreditCard className="h-4 w-4" />
                  Тарифы и диалоги
                </span>
                {usage && (
                  <span
                    className={cn(
                      "tabular-nums text-[11px]",
                      usage.exhausted ? "text-destructive font-semibold" : "text-muted-foreground"
                    )}
                  >
                    {fmt(usage.remaining)}
                  </span>
                )}
              </Link>
            </DropdownMenu.Item>

            <DropdownMenu.Separator className="my-1 h-px bg-border" />

            <DropdownMenu.Item
              onSelect={(e) => {
                e.preventDefault();
                void logout();
              }}
              disabled={busy}
              className="flex cursor-pointer items-center gap-2 rounded-md px-3 py-2 text-sm text-destructive outline-none focus:bg-destructive/10 data-[disabled]:opacity-50"
            >
              <LogOut className="h-4 w-4" />
              {busy ? "Выходим…" : "Выйти"}
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
    </div>
  );
}
