"use client";

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api";

type TourStep =
  | "describe_business"
  | "switch_to_test"
  | "write_client_message"
  | "correct_reply"
  // Legacy-значение: шаг подключения вынесен в подсказку в шапке (coachmark).
  // Если придёт из сервера/localStorage — трактуем как завершённый тур.
  | "connect_whatsapp"
  | "done";

const steps: Record<Exclude<TourStep, "done" | "connect_whatsapp">, { title: string; body: string; action: string }> = {
  describe_business: {
    title: "Шаг 1. Опишите бизнес",
    body: "Чем подробнее вы расскажете о нише, услугах, ценах и ограничениях, тем точнее будет промпт. Начните прямо в поле ниже.",
    action: "Далее"
  },
  switch_to_test: {
    title: "Шаг 2. Переключитесь в Тест",
    body: "Когда база собрана, переключитесь в Тест и отправьте сообщение от лица клиента.",
    action: "Далее"
  },
  write_client_message: {
    title: "Шаг 3. Пишите как клиент",
    body: "Не формулируйте правила — просто напишите обычный вопрос, будто вам пишет реальный клиент в WhatsApp.",
    action: "Далее"
  },
  correct_reply: {
    title: "Шаг 4. Поправляйте ответы",
    body: "Если бот ответил не так, нажмите «Поправить» и объясните, как нужно отвечать в следующий раз — промпт обновится автоматически. Когда всё готово — кнопка «Привязать WhatsApp» появится в шапке.",
    action: "Понятно"
  }
};

const STEP_ORDER: TourStep[] = [
  "describe_business",
  "switch_to_test",
  "write_client_message",
  "correct_reply",
  "done"
];

const storageKey = "jazu_onboarding_step";

type SettingsResponse = {
  success: boolean;
  user?: {
    onboardingState?: { step?: string } | null;
    telegramChatId?: string | null;
  };
};

export default function OnboardingTour() {
  const [step, setStep] = useState<TourStep>("done");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const local = window.localStorage.getItem(storageKey);
    // Legacy: шаг connect_whatsapp удалён из тура (его роль взяла подсказка
    // в шапке). Если юзер был на нём — считаем тур завершённым.
    if (local === "done" || local === "connect_whatsapp") {
      window.localStorage.setItem(storageKey, "done");
      setStep("done");
      setLoaded(true);
      return;
    }

    // Try to sync with server state for authenticated users
    apiJson<SettingsResponse>("/settings")
      .then((me) => {
        if (!me.success) {
          // Guest — use localStorage only
          const initial = STEP_ORDER[0];
          if (!local && initial) {
            setStep(initial);
          } else if (local && STEP_ORDER.includes(local as TourStep)) {
            setStep(local as TourStep);
          }
          return;
        }

        const serverStep = me.user?.onboardingState?.step;
        if (
          serverStep === "done" ||
          serverStep === "connect_whatsapp" ||
          local === "done"
        ) {
          window.localStorage.setItem(storageKey, "done");
          setStep("done");
          return;
        }

        const resolved = (serverStep || local || "describe_business") as TourStep;
        if (STEP_ORDER.includes(resolved)) {
          setStep(resolved);
        } else {
          const initial = STEP_ORDER[0];
          if (initial) {
            setStep(initial);
          }
        }
      })
      .catch(() => {
        const resolved = (local || "describe_business") as TourStep;
        setStep(STEP_ORDER.includes(resolved) ? resolved : "describe_business");
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) {
      return;
    }

    window.localStorage.setItem(storageKey, step);

    // Only save to server for authenticated users — silent fail for guests
    apiJson("/settings", {
      method: "PATCH",
      body: JSON.stringify({ onboardingState: { step, updatedAt: new Date().toISOString() } })
    }).catch(() => {});
  }, [step, loaded]);

  // connect_whatsapp — legacy-шаг без карточки (вынесен в подсказку шапки).
  if (!loaded || step === "done" || step === "connect_whatsapp") {
    return null;
  }

  const current = steps[step];
  if (!current) {
    return null;
  }

  function advance() {
    const idx = STEP_ORDER.indexOf(step);
    const next = STEP_ORDER[idx + 1] ?? "done";
    setStep(next);
  }

  return (
    <div className="fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom,0px)+7rem)] z-40 w-[min(92vw,22rem)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl sm:left-auto sm:right-4 sm:bottom-4 sm:translate-x-0">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
          Обучение · {STEP_ORDER.indexOf(step)}/{STEP_ORDER.length - 1}
        </div>
        <button
          type="button"
          onClick={() => setStep("done")}
          className="text-xs text-slate-400 hover:text-slate-600"
          aria-label="Закрыть онбординг"
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
