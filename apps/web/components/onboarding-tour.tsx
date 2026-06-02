"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
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
  // Предпочтительное положение относительно цели. "right" используется для
  // пунктов меню (карточка сбоку, стрелка влево); при нехватке места справа
  // measure() сам падает на "bottom".
  placement: "top" | "bottom" | "right";
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
    target: "nav-chats",
    placement: "right"
  },
  whatsapp: {
    title: "Шаг 5. WhatsApp",
    body: "Управление подключением: статус, смена номера, переподключение по коду или QR. Бот отвечает клиентам именно с этого номера.",
    action: "Далее",
    route: "/whatsapp",
    target: "nav-whatsapp",
    placement: "right"
  },
  settings: {
    title: "Шаг 6. Настройки",
    body: "Личный номер для уведомлений о лидах и подключение Telegram. Сюда же загляните, чтобы поменять данные аккаунта.",
    action: "Далее",
    route: "/settings",
    target: "nav-settings",
    placement: "right"
  },
  billing: {
    title: "Шаг 7. Тарифы",
    body: "Следите за остатком диалогов, продлевайте тариф и докупайте диалоги. Готово — теперь вы знаете весь кабинет!",
    action: "Завершить",
    route: "/billing",
    target: "nav-billing",
    placement: "right"
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
const CARD_HEIGHT_FALLBACK = 160; // оценка высоты карточки до первого замера
const GAP = 12;
const MARGIN = 12;

type Pos = {
  top?: number;
  bottom?: number;
  left: number;
  // Стрелка-указатель: для верх/низ — смещение по X (arrowLeft), для лево/право
  // — смещение по Y (arrowTop). Используется только соответствующее стороне.
  arrowSide: "top" | "bottom" | "left" | "right";
  arrowLeft?: number;
  arrowTop?: number;
};

type SettingsResponse = {
  success: boolean;
  user?: {
    onboardingState?: { step?: string } | null;
  };
};

// Действия при входе в шаг: переключение вкладки / открытие окна / шторки
// меню. Навигацию по маршруту делаем отдельно (нужен router/pathname).
function runStepSideEffects(id: AnyStep) {
  if (typeof window === "undefined") return;
  if (id === "extra_data") {
    window.dispatchEvent(new Event("jazu:switchToSetup"));
    window.dispatchEvent(new Event("jazu:closeNav"));
  } else if (id === "extra_data_window") {
    window.dispatchEvent(new Event("jazu:switchToSetup"));
    window.dispatchEvent(new Event("jazu:openExtraData"));
    window.dispatchEvent(new Event("jazu:closeNav"));
  } else if (id === "test") {
    window.dispatchEvent(new Event("jazu:closeExtraData"));
    window.dispatchEvent(new Event("jazu:switchToTest"));
    window.dispatchEvent(new Event("jazu:closeNav"));
  } else if (id === "chats" || id === "whatsapp" || id === "settings" || id === "billing") {
    // Эти шаги про целую страницу — окон не открываем, но на мобильном
    // открываем шторку меню, чтобы стрелка указывала на пункт.
    window.dispatchEvent(new Event("jazu:closeExtraData"));
    window.dispatchEvent(new Event("jazu:openNav"));
  } else if (id === "done") {
    window.dispatchEvent(new Event("jazu:closeNav"));
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
  const cardRef = useRef<HTMLDivElement>(null);

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
    // Цель может присутствовать в DOM дважды (мобильная шторка + десктоп-сайдбар).
    // Берём ВИДИМЫЙ инстанс: скрытый (display:none) даёт нулевой прямоугольник.
    const els = Array.from(
      document.querySelectorAll<HTMLElement>(`[data-tour="${def.target}"]`)
    );
    const el = els.find((node) => {
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    });
    if (!el) {
      setPos(null);
      return;
    }
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const cardW = Math.min(CARD_WIDTH, vw - MARGIN * 2);
    const cardH = cardRef.current?.getBoundingClientRect().height || CARD_HEIGHT_FALLBACK;

    const clamp = (v: number, min: number, max: number) => Math.max(min, Math.min(v, max));

    // "right" — карточка сбоку от пункта меню (стрелка влево). Если справа не
    // влезает (узкая мобильная шторка) — падаем на "bottom" (под пунктом).
    if (def.placement === "right") {
      const left = r.right + GAP;
      if (left + cardW <= vw - MARGIN) {
        const top = clamp(r.top, MARGIN, vh - MARGIN - cardH);
        const arrowTop = clamp(r.top + r.height / 2 - top, 16, cardH - 16);
        setPos({ top, left, arrowSide: "left", arrowTop });
        return;
      }
      // фолбэк: под пунктом
    }

    if (def.placement === "top") {
      const targetCenterX = r.left + r.width / 2;
      const left = clamp(targetCenterX - cardW / 2, MARGIN, vw - MARGIN - cardW);
      const arrowLeft = clamp(targetCenterX - left, 16, cardW - 16);
      setPos({ bottom: vh - r.top + GAP, left, arrowLeft, arrowSide: "bottom" });
      return;
    }

    // bottom (по умолчанию и фолбэк для right)
    const targetCenterX = r.left + r.width / 2;
    const left = clamp(targetCenterX - cardW / 2, MARGIN, vw - MARGIN - cardW);
    const arrowLeft = clamp(targetCenterX - left, 16, cardW - 16);
    setPos({ top: r.bottom + GAP, left, arrowLeft, arrowSide: "top" });
  }, [def]);

  // Сбрасываем позицию при смене шага, чтобы карточка не «прыгала» из старой
  // точки: она появится уже на новом якоре после ближайшего measure().
  useLayoutEffect(() => {
    setPos(null);
  }, [step]);

  useLayoutEffect(() => {
    if (!active || !def?.target) {
      setPos(null);
      return;
    }
    measure();
    // Цель может появиться/сдвинуться после навигации и анимации шторки —
    // до-наводим интервалом.
    const id = window.setInterval(measure, 200);
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
    } else {
      // Конец тура — закрываем шторку, если она была открыта последним шагом.
      runStepSideEffects("done");
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

  // Стрелка-указатель: квадрат-«ромб» на нужной стороне карточки.
  function arrowStyle(p: Pos): CSSProperties {
    switch (p.arrowSide) {
      case "bottom":
        return { bottom: -6, left: (p.arrowLeft ?? 24) - 6, borderRight: "1px solid", borderBottom: "1px solid" };
      case "top":
        return { top: -6, left: (p.arrowLeft ?? 24) - 6, borderLeft: "1px solid", borderTop: "1px solid" };
      case "left":
        return { left: -6, top: (p.arrowTop ?? 24) - 6, borderLeft: "1px solid", borderBottom: "1px solid" };
      case "right":
      default:
        return { right: -6, top: (p.arrowTop ?? 24) - 6, borderRight: "1px solid", borderTop: "1px solid" };
    }
  }

  // Карточка, привязанная к элементу (стрелка-указатель).
  if (def.target && pos) {
    return (
      <div
        ref={cardRef}
        className="pointer-events-auto fixed z-[60] w-[320px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl transition-[top,left,bottom] duration-200"
        style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}
        role="dialog"
        aria-live="polite"
      >
        <div
          className="absolute h-3 w-3 rotate-45 border-slate-200 bg-white"
          style={arrowStyle(pos)}
          aria-hidden
        />
        {inner}
      </div>
    );
  }

  // Фолбэк: у шага есть target, но он ещё не виден (идёт навигация, едет
  // шторка) — показываем плавающую карточку снизу, чтобы тур не «исчезал»
  // (его нельзя скипнуть). Для страничных шагов без target — то же место.
  return (
    <div
      ref={cardRef}
      className="pointer-events-auto fixed left-1/2 bottom-[calc(env(safe-area-inset-bottom,0px)+5rem)] z-[60] w-[min(92vw,22rem)] -translate-x-1/2 rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl sm:left-auto sm:right-4 sm:bottom-4 sm:translate-x-0"
      role="dialog"
      aria-live="polite"
    >
      {inner}
    </div>
  );
}
