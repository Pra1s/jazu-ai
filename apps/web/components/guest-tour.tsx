"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Пошаговый тур для НЕзарегистрированного гостя на дашборде. Ведёт по воронке
 * настройки: описать бизнес → протестировать → подключить WhatsApp. Каждый
 * шаг — карточка с текстом и кнопкой «Далее» (как обзор-тур в кабинете).
 *
 * Особенности:
 *  - Показываем только гостю и только на /dashboard.
 *  - Состояние храним в localStorage (у гостя нет серверного аккаунта).
 *  - Если в тесте сработал «горячий» триггер (jazu:connectHintShown) — прячем
 *    тур, чтобы не накладываться на непропускаемую подсказку у кнопки.
 */
type GuestStep = "describe" | "test" | "connect" | "done";

type StepDef = { title: string; body: string; action: string };

const STEPS: Record<Exclude<GuestStep, "done">, StepDef> = {
  describe: {
    title: "Шаг 1. Опишите бизнес",
    body: "Напишите в поле ниже одним сообщением, чем вы занимаетесь — AI соберёт промпт бота и задаст уточняющие вопросы.",
    action: "Далее"
  },
  test: {
    title: "Шаг 2. Протестируйте бота",
    body: "Переключитесь во вкладку «Тест» внизу и напишите как ваш клиент. Если ответ не нравится — нажмите «Поправить».",
    action: "Далее"
  },
  connect: {
    title: "Шаг 3. Подключите WhatsApp",
    body: "Когда бот готов — нажмите «Подключить WhatsApp» вверху справа, чтобы запустить его на реальных клиентах.",
    action: "Понятно"
  }
};

const STEP_ORDER: GuestStep[] = ["describe", "test", "connect", "done"];
const STORAGE_KEY = "jazu_guest_tour_step";

export default function GuestTour() {
  const pathname = usePathname();
  const authStatus = useAuthStatus();
  const [step, setStep] = useState<GuestStep>("done");
  const [loaded, setLoaded] = useState(false);
  // Скрываем тур, если сработал «горячий» триггер у кнопки подключения.
  const [hiddenByTrigger, setHiddenByTrigger] = useState(false);

  useEffect(() => {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    if (saved === "done") {
      setStep("done");
    } else if (saved && STEP_ORDER.includes(saved as GuestStep)) {
      setStep(saved as GuestStep);
    } else {
      setStep(STEP_ORDER[0] as GuestStep);
    }
    setLoaded(true);

    const onTrigger = () => setHiddenByTrigger(true);
    window.addEventListener("jazu:connectHintShown", onTrigger);
    return () => window.removeEventListener("jazu:connectHintShown", onTrigger);
  }, []);

  useEffect(() => {
    if (!loaded) return;
    window.localStorage.setItem(STORAGE_KEY, step);
  }, [step, loaded]);

  // Тур только для гостя на дашборде. Авторизованный увидит OnboardingTour.
  // Требуем явный статус «гость» (ok === false), чтобы тур не мигнул у
  // авторизованного, пока грузится /auth/me (authStatus === null).
  const isGuest = authStatus?.ok === false;
  const onDashboard = pathname === "/dashboard";

  if (!loaded || hiddenByTrigger || !isGuest || !onDashboard || step === "done") {
    return null;
  }

  const current = STEPS[step];
  if (!current) return null;

  function advance() {
    const idx = STEP_ORDER.indexOf(step);
    setStep(STEP_ORDER[idx + 1] ?? "done");
  }

  return (
    <div className="fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom,0px)+7rem)] z-40 w-[min(92vw,22rem)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl sm:left-auto sm:right-4 sm:bottom-4 sm:translate-x-0">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
          Старт · {STEP_ORDER.indexOf(step) + 1}/{STEP_ORDER.length - 1}
        </div>
        <button
          type="button"
          onClick={() => setStep("done")}
          className="text-xs text-slate-400 hover:text-slate-600"
          aria-label="Закрыть подсказки"
        >
          ✕
        </button>
      </div>
      <div className="mt-2 text-sm font-semibold text-slate-900">{current.title}</div>
      <div className="mt-1.5 text-sm leading-5 text-slate-600">{current.body}</div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={advance}
          className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          {current.action}
        </button>
      </div>
    </div>
  );
}
