"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { MessageCircle, Zap, X } from "lucide-react";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";

type ProgressResponse = {
  hasPrompt: boolean;
  correctionsCount: number;
  waConnected: boolean;
};

const COACHMARK_DISMISSED_KEY = "jazu_wa_coachmark_dismissed";
const MIN_CORRECTIONS = 2;

function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-foreground">
        <Zap className="h-4 w-4 text-background" />
      </div>
      <span className="text-sm font-semibold tracking-tight text-foreground">Jazu</span>
    </Link>
  );
}

export default function GuestHeader() {
  const pathname = usePathname();
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [coachmarkDismissed, setCoachmarkDismissed] = useState(true);

  const refreshProgress = useCallback(async () => {
    try {
      const data = await apiJson<ProgressResponse>("/agent/progress");
      setProgress(data);
    } catch {
      /* non-critical — подсказка просто не появится */
    }
  }, []);

  useEffect(() => {
    // Скрытие подсказки — только на текущую сессию (sessionStorage), а не
    // навсегда. Иначе один случайный «крестик» прятал подсказку в браузере
    // безвозвратно, и пользователь больше не получал подсказку в воронке.
    // Подсказка всё равно исчезнет сама после подключения WhatsApp (см.
    // условие showCta с !waConnected).
    setCoachmarkDismissed(
      window.sessionStorage.getItem(COACHMARK_DISMISSED_KEY) === "1"
    );
    void refreshProgress();

    const handler = () => void refreshProgress();
    window.addEventListener("jazu:promptProgress", handler);
    return () => window.removeEventListener("jazu:promptProgress", handler);
  }, [refreshProgress]);

  // CTA показываем, когда промпт собран, сделано минимум 2 правки и WhatsApp
  // ещё не подключён. На странице самой привязки/входа CTA не нужен.
  const isAuthPath = pathname.startsWith("/auth");
  const isWhatsappPath = pathname.startsWith("/whatsapp");
  const showCta =
    !!progress &&
    progress.hasPrompt &&
    progress.correctionsCount >= MIN_CORRECTIONS &&
    !progress.waConnected &&
    !isWhatsappPath;

  const showCoachmark = showCta && !coachmarkDismissed;

  function dismissCoachmark() {
    setCoachmarkDismissed(true);
    window.sessionStorage.setItem(COACHMARK_DISMISSED_KEY, "1");
  }

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:px-6">
      <Logo />

      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        {showCta && (
          <div className="sm:relative">
            <Link
              href="/whatsapp"
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#25D366] px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#1ebe5c] sm:gap-2 sm:px-4 sm:text-sm",
                showCoachmark && "ring-2 ring-[#25D366]/40 ring-offset-2 ring-offset-background"
              )}
            >
              <MessageCircle className="h-4 w-4 shrink-0" />
              <span className="sm:hidden">Привязать</span>
              <span className="hidden sm:inline">Привязать WhatsApp</span>
            </Link>

            {showCoachmark && (
              <div
                className={cn(
                  // Мобильный: фиксированная карточка под шапкой с отступами от
                  // краёв экрана, чтобы текст не обрезался. Десктоп: выпадашка
                  // от кнопки справа.
                  "fixed inset-x-3 top-[calc(3.5rem+0.5rem)] z-40 rounded-2xl bg-[#2563eb] p-4 text-white shadow-2xl",
                  "sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+10px)] sm:w-80"
                )}
              >
                {/* стрелка-указатель к кнопке — только на десктопе */}
                <div className="absolute -top-1.5 right-8 hidden h-3 w-3 rotate-45 bg-[#2563eb] sm:block" />
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold leading-5">
                    Бот готов — подключите WhatsApp
                  </h3>
                  <button
                    type="button"
                    onClick={dismissCoachmark}
                    aria-label="Закрыть подсказку"
                    className="-mr-1 -mt-1 shrink-0 rounded-full p-1 text-white/70 transition hover:bg-white/10 hover:text-white"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-1.5 text-sm leading-5 text-white/90">
                  Вы собрали промпт и отладили ответы на правках. Нажмите
                  «Привязать WhatsApp»: после быстрой регистрации бот начнёт
                  отвечать клиентам 24/7, а горячие лиды будут приходить вам в
                  Telegram.
                </p>
                <button
                  type="button"
                  onClick={dismissCoachmark}
                  className="mt-3 rounded-full bg-white px-4 py-1.5 text-sm font-semibold text-[#2563eb] transition hover:bg-white/90"
                >
                  Понятно
                </button>
              </div>
            )}
          </div>
        )}

        {!isAuthPath && (
          <Link
            href="/auth"
            className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary sm:px-4 sm:text-sm"
          >
            Войти
          </Link>
        )}
      </div>
    </header>
  );
}
