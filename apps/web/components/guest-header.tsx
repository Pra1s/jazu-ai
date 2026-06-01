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

  // Кнопку «Подключить WhatsApp» (вместо «Войти») показываем, как только у
  // гостя собран промпт и WhatsApp ещё не подключён — то есть на странице
  // настройки/теста. На лендинге (промпта ещё нет) оставляем «Войти».
  const isAuthPath = pathname.startsWith("/auth");
  const isWhatsappPath = pathname.startsWith("/whatsapp");
  const showWaCta =
    !!progress && progress.hasPrompt && !progress.waConnected && !isWhatsappPath;

  // Пульсирующую подсказку у кнопки включаем чуть позже — когда промпт собран
  // и сделано минимум 2 правки (бот реально отлажен).
  const showCta =
    showWaCta && (progress?.correctionsCount ?? 0) >= MIN_CORRECTIONS;

  const showCoachmark = showCta && !coachmarkDismissed;

  function dismissCoachmark() {
    setCoachmarkDismissed(true);
    window.sessionStorage.setItem(COACHMARK_DISMISSED_KEY, "1");
  }

  return (
    <header className="relative z-30 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:px-6">
      <Logo />

      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        {!isAuthPath && showWaCta && (
          <div className="sm:relative">
            <Link
              href="/whatsapp"
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#25D366] px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#1ebe5c] sm:gap-2 sm:px-4 sm:text-sm",
                showCoachmark && "ring-2 ring-[#25D366]/40 ring-offset-2 ring-offset-background"
              )}
            >
              <MessageCircle className="h-4 w-4 shrink-0" />
              <span className="sm:hidden">Подключить</span>
              <span className="hidden sm:inline">Подключить WhatsApp</span>
            </Link>

            {showCoachmark && (
              <div
                className={cn(
                  // Мобильный: фиксированная карточка под шапкой с отступами от
                  // краёв экрана, чтобы текст не обрезался. Десктоп: выпадашка
                  // от кнопки справа. Стиль — как у обучающих подсказок сайта.
                  "fixed inset-x-3 top-[calc(3.5rem+0.5rem)] z-40 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl",
                  "sm:absolute sm:inset-x-auto sm:right-0 sm:top-[calc(100%+10px)] sm:w-80"
                )}
              >
                {/* стрелка-указатель к кнопке — только на десктопе */}
                <div className="absolute -top-1.5 right-8 hidden h-3 w-3 rotate-45 border-l border-t border-slate-200 bg-white sm:block" />
                <div className="flex items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold leading-5 text-slate-900">
                    Бот готов, подключите WhatsApp
                  </h3>
                  <button
                    type="button"
                    onClick={dismissCoachmark}
                    aria-label="Закрыть подсказку"
                    className="-mr-1 -mt-1 shrink-0 rounded-full p-1 text-slate-400 transition hover:bg-slate-100 hover:text-slate-600"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="mt-1.5 text-sm leading-5 text-slate-600">
                  Вы собрали промпт и отладили ответы на правках. Нажмите
                  «Подключить WhatsApp»: после быстрой регистрации бот начнёт
                  отвечать клиентам 24/7, а уведомления о лидах и их статусе
                  будут приходить в WhatsApp.
                </p>
                <button
                  type="button"
                  onClick={dismissCoachmark}
                  className="mt-3 rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
                >
                  Понятно
                </button>
              </div>
            )}
          </div>
        )}

        {!isAuthPath && !showWaCta && (
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
