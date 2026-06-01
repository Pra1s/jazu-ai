"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { apiJson } from "@/lib/api";

type TourStep =
  | "extra_data"
  | "test_mode"
  | "chats"
  | "whatsapp"
  | "billing"
  // Legacy-значения (из старого тура / сервера) — трактуем как завершённый тур.
  | "describe_business"
  | "switch_to_test"
  | "write_client_message"
  | "correct_reply"
  | "connect_whatsapp"
  | "done";

type StepDef = { title: string; body: string; action: string; href?: string };

// Обзор-тур по кабинету. Начинается с кнопки доп-данных на дашборде, дальше
// ведёт по вкладкам — каждый «Далее» авто-переходит на нужную страницу.
const steps: Record<Exclude<TourStep, "done" | "describe_business" | "switch_to_test" | "write_client_message" | "correct_reply" | "connect_whatsapp">, StepDef> = {
  extra_data: {
    title: "Шаг 1. Данные о бизнесе",
    body: "Нажмите «Доп. данные» в шапке, чтобы добавить прайс, адреса, часы работы, ссылки и ограничения - бот будет использовать их в ответах.",
    action: "Далее",
    href: "/dashboard"
  },
  test_mode: {
    title: "Шаг 2. Протестируйте бота",
    body: "Переключитесь в «Тест» и напишите как клиент. Если ответ не нравится - нажмите «Поправить».",
    action: "Далее",
    href: "/dashboard"
  },
  chats: {
    title: "Шаг 3. Диалоги и лиды",
    body: "Здесь видны переписки клиентов с ботом и горячие лиды. Бота можно поставить на паузу.",
    action: "Далее",
    href: "/chats"
  },
  whatsapp: {
    title: "Шаг 4. Подключите WhatsApp",
    body: "На этой странице привяжите номер по коду или QR - и бот начнёт отвечать реальным клиентам.",
    action: "Далее",
    href: "/whatsapp"
  },
  billing: {
    title: "Шаг 5. Тарифы и диалоги",
    body: "Следите за остатком диалогов, продлевайте тариф и докупайте диалоги здесь.",
    action: "Понятно",
    href: "/billing"
  }
};

const STEP_ORDER: TourStep[] = ["extra_data", "test_mode", "chats", "whatsapp", "billing", "done"];

const LEGACY_STEPS = new Set<string>([
  "describe_business",
  "switch_to_test",
  "write_client_message",
  "correct_reply",
  "connect_whatsapp"
]);

const storageKey = "jazu_onboarding_step";

type SettingsResponse = {
  success: boolean;
  user?: {
    onboardingState?: { step?: string } | null;
    telegramChatId?: string | null;
  };
};

export default function OnboardingTour() {
  const router = useRouter();
  const [step, setStep] = useState<TourStep>("done");
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    const local = window.localStorage.getItem(storageKey);

    apiJson<SettingsResponse>("/settings")
      .then((me) => {
        // Источник правды — СЕРВЕР. localStorage больше не перекрывает свежее
        // серверное состояние: иначе на браузере, где тур когда-то проходили
        // (local === "done"), новый зарегистрированный аккаунт никогда бы не
        // увидел тур, хотя на сервере у него onboardingState ещё пустой.
        if (!me.success) {
          // Теоретически тур смонтирован только для авторизованных, но на
          // всякий случай падаем на localStorage.
          if (local === "done" || (local && LEGACY_STEPS.has(local))) {
            setStep("done");
          } else {
            const resolved = (local && STEP_ORDER.includes(local as TourStep))
              ? (local as TourStep)
              : (STEP_ORDER[0] as TourStep);
            setStep(resolved);
          }
          return;
        }

        const serverStep = me.user?.onboardingState?.step;

        // Тур считается пройденным ТОЛЬКО если так говорит сервер.
        if (serverStep === "done" || (serverStep && LEGACY_STEPS.has(serverStep))) {
          window.localStorage.setItem(storageKey, "done");
          setStep("done");
          return;
        }

        // Сервер хранит конкретный валидный шаг — продолжаем с него.
        if (serverStep && STEP_ORDER.includes(serverStep as TourStep)) {
          setStep(serverStep as TourStep);
          return;
        }

        // Сервер пуст (новый аккаунт) — стартуем тур с первого шага, даже если
        // в localStorage осталось "done" от другого аккаунта на этом браузере.
        setStep(STEP_ORDER[0] as TourStep);
      })
      .catch(() => {
        // Сеть недоступна — фолбэк на localStorage, чтобы тур не мигал.
        if (local === "done" || (local && LEGACY_STEPS.has(local))) {
          setStep("done");
          return;
        }
        const resolved = (local && STEP_ORDER.includes(local as TourStep))
          ? (local as TourStep)
          : (STEP_ORDER[0] as TourStep);
        setStep(resolved);
      })
      .finally(() => setLoaded(true));
  }, []);

  useEffect(() => {
    if (!loaded) return;
    window.localStorage.setItem(storageKey, step);
    apiJson("/settings", {
      method: "PATCH",
      body: JSON.stringify({ onboardingState: { step, updatedAt: new Date().toISOString() } })
    }).catch(() => {});
  }, [step, loaded]);

  if (!loaded || step === "done" || LEGACY_STEPS.has(step)) {
    return null;
  }

  const current = (steps as Record<string, StepDef>)[step];
  if (!current) {
    return null;
  }

  function advance() {
    const idx = STEP_ORDER.indexOf(step);
    const next = STEP_ORDER[idx + 1] ?? "done";
    setStep(next);
    // Авто-переход на страницу следующего шага.
    if (next !== "done") {
      const nextDef = (steps as Record<string, StepDef>)[next];
      if (nextDef?.href) router.push(nextDef.href);
    }
  }

  return (
    <div className="fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom,0px)+7rem)] z-40 w-[min(92vw,22rem)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl sm:left-auto sm:right-4 sm:bottom-4 sm:translate-x-0">
      <div className="flex items-center justify-between gap-3">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
          Обзор · {STEP_ORDER.indexOf(step) + 1}/{STEP_ORDER.length - 1}
        </div>
        <button
          type="button"
          onClick={() => setStep("done")}
          className="text-xs text-slate-400 hover:text-slate-600"
          aria-label="Закрыть обзор"
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
