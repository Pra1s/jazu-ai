"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Zap, X } from "lucide-react";
import { persistNext } from "@/lib/safe-next";

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}
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
  const router = useRouter();
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [coachmarkDismissed, setCoachmarkDismissed] = useState(true);
  // Когда в тесте срабатывает непропускаемая подсказка-триггер, прячем мягкий
  // coachmark, чтобы две подсказки у одной кнопки не накладывались.
  const [ctaLocked, setCtaLocked] = useState(false);

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
    const lockHandler = () => setCtaLocked(true);
    window.addEventListener("jazu:promptProgress", handler);
    window.addEventListener("jazu:connectHintShown", lockHandler);
    return () => {
      window.removeEventListener("jazu:promptProgress", handler);
      window.removeEventListener("jazu:connectHintShown", lockHandler);
    };
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

  const showCoachmark = showCta && !coachmarkDismissed && !ctaLocked;

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
            <button
              type="button"
              onClick={() => {
                persistNext("/whatsapp");
                router.push("/auth?next=/whatsapp");
              }}
              className={cn(
                "flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#25D366] px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#1ebe5c] sm:gap-2 sm:px-4 sm:text-sm",
                showCoachmark && "ring-2 ring-[#25D366]/40 ring-offset-2 ring-offset-background"
              )}
            >
              <WhatsAppIcon className="h-4 w-4 shrink-0" />
              Подключить WhatsApp
            </button>

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
