"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { apiJson } from "@/lib/api";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Обзорный тур по кабинету для нового пользователя.
 *
 * Когда показываем:
 *  - только авторизованному юзеру, который ПОЛНОСТЬЮ прошёл онбординг
 *    (`needsPhone === false`: WhatsApp подключён и личный номер подтверждён);
 *  - и только если на сервере `onboardingState.step` ещё не «done».
 *
 * Поведение:
 *  - тур НЕЛЬЗЯ скипнуть: нет крестика, единственное действие — «Далее»;
 *  - стартует от кнопки «Добавить данные о бизнесе» на дашборде (карточка со
 *    стрелкой-указателем), дальше ведёт по кабинету;
 *  - при «Далее» сам выполняет нужное действие следующего шага: переключает
 *    вкладку, открывает окно доп-данных или переходит на нужную страницу.
 */
type StepId =
  | "extra_data"
  | "extra_data_window"
  | "test"
  | "chats"
  | "whatsapp"
  | "settings"
  | "billing";

type AnyStep = StepId | "done";

type StepDef = {
  title: string;
  body: string;
  action: string;
  // Маршрут, на котором живёт шаг.
  route: string;
  // К какому элементу привязать карточку (data-tour). Если нет — карточка
  // показывается по центру снизу (шаг про целую страницу).
  target?: string;
  placement: "top" | "bottom";
};

const STEPS: Record<StepId, StepDef> = {
  extra_data: {
    title: "Шаг 1. Данные о бизнесе",
    body: "Начнём отсюда. Нажмите «Добавить данные о бизнесе», чтобы внести прайс, адреса, часы работы и ссылки — бот будет использовать их в ответах.",
    action: "Далее",
    route: "/dashboard",
    target: "extra-data-btn",
    placement: "bottom"
  },
  extra_data_window: {
    title: "Шаг 2. Заполните детали",
    body: "В этом окне добавьте прайс, скрипт продаж, адреса, время работы и ограничения. Чем больше деталей — тем точнее отвечает бот. Заполнить можно в любой момент.",
    action: "Далее",
    route: "/dashboard",
    placement: "bottom"
  },
  test: {
    title: "Шаг 3. Протестируйте бота",
    body: "Вкладка «Тест» — напишите как клиент и проверьте ответы. Не нравится ответ — нажмите «Поправить», и бот перестроится.",
    action: "Далее",
    route: "/dashboard",
    target: "test-tab",
    placement: "top"
  },
  chats: {
    title: "Шаг 4. Диалоги и лиды",
    body: "Здесь все переписки клиентов с ботом и горячие лиды. Любой диалог можно поставить на паузу — бот перестанет отвечать, пока вы не включите его снова.",
    action: "Далее",
    route: "/chats",
    placement: "bottom"
  },
  whatsapp: {
    title: "Шаг 5. WhatsApp",
    body: "Управление подключением: статус, смена номера, переподключение по коду или QR. Бот отвечает клиентам именно с этого номера.",
    action: "Далее",
    route: "/whatsapp",
    placement: "bottom"
  },
  settings: {
    title: "Шаг 6. Настройки",
    body: "Личный номер для уведомлений о лидах и подключение Telegram. Сюда же загляните, чтобы поменять данные аккаунта.",
    action: "Далее",
    route: "/settings",
    placement: "bottom"
  },
  billing: {
    title: "Шаг 7. Тарифы",
    body: "Следите за остатком диалогов, продлевайте тариф и докупайте диалоги. Готово — теперь вы знаете весь кабинет!",
    action: "Завершить",
    route: "/billing",
    placement: "bottom"
  }
};

const STEP_ORDER: AnyStep[] = [
  "extra_data",
  "extra_data_window",
  "test",
  "chats",
  "whatsapp",
  "settings",
  "billing",
  "done"
];

// Старые значения шага (из прошлых версий тура) трактуем как «тур уже видели».
const LEGACY_STEPS = new Set<string>([
  "describe_business",
  "switch_to_test",
  "write_client_message",
  "correct_reply",
  "connect_whatsapp",
  "test_mode"
]);

const storageKey = "jazu_onboarding_step";

const CARD_WIDTH = 320;
const GAP = 12;
const MARGIN = 12;

type Pos = {
  top?: number;
  bottom?: number;
  left: number;
  arrowLeft: number;
  arrowSide: "top" | "bottom";
};

type SettingsResponse = {
  success: boolean;
  user?: {
    onboardingState?: { step?: string } | null;
  };
};

// Действия при входе в шаг: переключение вкладки / открытие окна. Навигацию
// по маршруту делаем отдельно (нужен router/pathname).
function runStepSideEffects(id: AnyStep) {
  if (typeof window === "undefined") return;
  if (id === "extra_data") {
    window.dispatchEvent(new Event("jazu:switchToSetup"));
  } else if (id === "extra_data_window") {
    window.dispatchEvent(new Event("jazu:switchToSetup"));
    window.dispatchEvent(new Event("jazu:openExtraData"));
  } else if (id === "test") {
    window.dispatchEvent(new Event("jazu:closeExtraData"));
    window.dispatchEvent(new Event("jazu:switchToTest"));
  } else if (id === "chats" || id === "whatsapp" || id === "settings" || id === "billing") {
    // Эти шаги про целую страницу — окон не открываем.
    window.dispatchEvent(new Event("jazu:closeExtraData"));
  }
}

function resolveStartStep(serverStep: string | undefined, local: string | null): AnyStep {
  if (serverStep === "done" || (serverStep && LEGACY_STEPS.has(serverStep))) return "done";
  if (serverStep && STEP_ORDER.includes(serverStep as AnyStep)) return serverStep as AnyStep;
  if (serverStep) return "done"; // неизвестное значение — считаем пройденным
  // Сервер пуст (новый аккаунт). localStorage не даём перекрыть старт «done»
  // от другого аккаунта на этом браузере.
  if (local && STEP_ORDER.includes(local as AnyStep) && local !== "done") return local as AnyStep;
  return STEP_ORDER[0] as AnyStep;
}

export default function OnboardingTour() {
  const router = useRouter();
  const pathname = usePathname();
  const authStatus = useAuthStatus();

  const [step, setStep] = useState<AnyStep>("done");
  const [loaded, setLoaded] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);
  const startedRef = useRef(false);

  // Юзер прошёл онбординг полностью (есть телефон). Только тогда показываем тур.
  const eligible = authStatus?.ok === true && authStatus.needsPhone === false;

  // Однократная загрузка состояния тура с сервера, как только юзер eligible.
  useEffect(() => {
    if (!eligible || startedRef.current) return;
    startedRef.current = true;

    const local = typeof window !== "undefined" ? window.localStorage.getItem(storageKey) : null;
    apiJson<SettingsResponse>("/settings")
      .then((me) => {
        const serverStep = me.success ? me.user?.onboardingState?.step : undefined;
        const start = resolveStartStep(serverStep ?? undefined, local);
        setStep(start);
        if (start !== "done") {
          if (pathname !== STEPS[start].route) {
            router.push(STEPS[start].route);
          }
          runStepSideEffects(start);
        }
      })
      .catch(() => {
        const start = resolveStartStep(undefined, local);
        setStep(start);
        if (start !== "done") runStepSideEffects(start);
      })
      .finally(() => setLoaded(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligible]);

  // Персист шага: localStorage + сервер. Только когда тур реально активен.
  useEffect(() => {
    if (!loaded || !eligible) return;
    window.localStorage.setItem(storageKey, step);
    apiJson("/settings", {
      method: "PATCH",
      body: JSON.stringify({ onboardingState: { step, updatedAt: new Date().toISOString() } })
    }).catch(() => {});
  }, [step, loaded, eligible]);

  const active = loaded && eligible && step !== "done";
  const def = active ? STEPS[step] : null;

  // Пересчёт позиции карточки относительно целевого элемента (если он есть).
  const measure = useCallback(() => {
    if (!def || !def.target) {
      setPos(null);
      return;
    }
    const el = document.querySelector<HTMLElement>(`[data-tour="${def.target}"]`);
    if (!el) {
      setPos(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const cardW = Math.min(CARD_WIDTH, vw - MARGIN * 2);
    const targetCenterX = r.left + r.width / 2;
    let left = targetCenterX - cardW / 2;
    left = Math.max(MARGIN, Math.min(left, vw - MARGIN - cardW));
    const arrowLeft = Math.max(16, Math.min(targetCenterX - left, cardW - 16));

    if (def.placement === "top") {
      setPos({ bottom: window.innerHeight - r.top + GAP, left, arrowLeft, arrowSide: "bottom" });
    } else {
      setPos({ top: r.bottom + GAP, left, arrowLeft, arrowSide: "top" });
    }
  }, [def]);

  useLayoutEffect(() => {
    if (!active || !def?.target) {
      setPos(null);
      return;
    }
    measure();
    const id = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, def, measure]);

  if (!active || !def) {
    return null;
  }

  function advance() {
    const idx = STEP_ORDER.indexOf(step);
    const next = STEP_ORDER[idx + 1] ?? "done";
    setStep(next);
    if (next !== "done") {
      const nextDef = STEPS[next];
      if (pathname !== nextDef.route) router.push(nextDef.route);
      runStepSideEffects(next);
    }
  }

  const stepNumber = STEP_ORDER.indexOf(step) + 1;
  const totalSteps = STEP_ORDER.length - 1;

  const inner = (
    <>
      <div className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">
        Обзор · {stepNumber}/{totalSteps}
      </div>
      <div className="mt-2 text-sm font-semibold text-slate-900">{def.title}</div>
      <div className="mt-1.5 text-sm leading-5 text-slate-600">{def.body}</div>
      <div className="mt-4 flex justify-end">
        <button
          type="button"
          onClick={advance}
          className="rounded-full bg-slate-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-slate-800"
        >
          {def.action}
        </button>
      </div>
    </>
  );

  // Карточка, привязанная к элементу (стрелка-указатель).
  if (def.target && pos) {
    return (
      <div
        className="pointer-events-auto fixed z-[60] w-[320px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl"
        style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}
        role="dialog"
        aria-live="polite"
      >
        <div
          className="absolute h-3 w-3 rotate-45 border-slate-200 bg-white"
          style={
            pos.arrowSide === "bottom"
              ? { bottom: -6, left: pos.arrowLeft - 6, borderRight: "1px solid", borderBottom: "1px solid" }
              : { top: -6, left: pos.arrowLeft - 6, borderLeft: "1px solid", borderTop: "1px solid" }
          }
          aria-hidden
        />
        {inner}
      </div>
    );
  }

  // Карточка про целую страницу / окно — фиксируем снизу по центру (выше
  // модалок: z-[60], чтобы быть поверх окна доп-данных).
  return (
    <div
      className="pointer-events-auto fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] z-[60] w-[min(92vw,22rem)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl sm:left-auto sm:right-4 sm:bottom-4 sm:translate-x-0"
      role="dialog"
      aria-live="polite"
    >
      {inner}
    </div>
  );
}
