"use client";

import { useCallback, useEffect, useLayoutEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { useAuthStatus } from "@/lib/use-auth-status";

/**
 * Пошаговый тур для НЕзарегистрированного гостя на дашборде. Ведёт по воронке
 * настройки: описать бизнес → протестировать → подключить WhatsApp. Каждый шаг
 * — карточка, ПРИВЯЗАННАЯ к конкретной кнопке (со стрелкой-указателем):
 *   describe → поле ввода композера (data-tour="composer")
 *   test     → вкладка «Тест» (data-tour="test-tab")
 *   connect  → кнопка «Подключить WhatsApp» в шапке (data-tour="connect-wa")
 *
 * Особенности:
 *  - Показываем только гостю и только на /dashboard.
 *  - Состояние храним в localStorage (у гостя нет серверного аккаунта).
 *  - Если в тесте сработал «горячий» триггер (jazu:connectHintShown) — прячем
 *    тур, чтобы не накладываться на непропускаемую подсказку у кнопки.
 */
type GuestStep = "describe" | "test" | "connect" | "done";

type StepDef = {
  title: string;
  body: string;
  action: string;
  target: string;
  // Куда отрисовать карточку относительно цели.
  placement: "top" | "bottom";
};

const STEPS: Record<Exclude<GuestStep, "done">, StepDef> = {
  describe: {
    title: "Шаг 1. Опишите бизнес",
    body: "Напишите здесь одним сообщением, чем вы занимаетесь — AI соберёт промпт бота и задаст уточняющие вопросы.",
    action: "Далее",
    target: "composer",
    placement: "top"
  },
  test: {
    title: "Шаг 2. Протестируйте бота",
    body: "Переключитесь во вкладку «Тест» и напишите как ваш клиент. Если ответ не нравится — нажмите «Поправить».",
    action: "Далее",
    target: "test-tab",
    placement: "top"
  },
  connect: {
    title: "Шаг 3. Подключите WhatsApp",
    body: "Когда бот готов — нажмите «Подключить WhatsApp», чтобы запустить его на реальных клиентах.",
    action: "Понятно",
    target: "connect-wa",
    placement: "bottom"
  }
};

const STEP_ORDER: GuestStep[] = ["describe", "test", "connect", "done"];
const STORAGE_KEY = "jazu_guest_tour_step";

const CARD_WIDTH = 320; // px, синхронно с w-[320px] ниже
const GAP = 12; // зазор между карточкой и целью
const MARGIN = 12; // минимальный отступ от краёв экрана

type Pos = {
  // Используем либо top, либо bottom (CSS), чтобы не зависеть от высоты карточки.
  top?: number;
  bottom?: number;
  left: number;
  arrowLeft: number; // позиция стрелки относительно левого края карточки
  arrowSide: "top" | "bottom";
};

export default function GuestTour() {
  const pathname = usePathname();
  const authStatus = useAuthStatus();
  const [step, setStep] = useState<GuestStep>("done");
  const [loaded, setLoaded] = useState(false);
  const [hiddenByTrigger, setHiddenByTrigger] = useState(false);
  const [pos, setPos] = useState<Pos | null>(null);

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

  const isGuest = authStatus?.ok === false;
  const onDashboard = pathname === "/dashboard";
  const active =
    loaded && !hiddenByTrigger && isGuest && onDashboard && step !== "done";

  const def = active ? STEPS[step] : null;

  // Пересчёт позиции карточки относительно целевой кнопки.
  const measure = useCallback(() => {
    if (!def) {
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
      // Карточка над целью: фиксируем нижний край на GAP выше верха цели.
      setPos({
        bottom: window.innerHeight - r.top + GAP,
        left,
        arrowLeft,
        arrowSide: "bottom"
      });
    } else {
      // Карточка под целью.
      setPos({
        top: r.bottom + GAP,
        left,
        arrowLeft,
        arrowSide: "top"
      });
    }
  }, [def]);

  useLayoutEffect(() => {
    if (!active) {
      setPos(null);
      return;
    }
    measure();
    // Цели меняют размер/положение (растущий textarea, ресайз, прокрутка).
    const id = window.setInterval(measure, 250);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, true);
    return () => {
      window.clearInterval(id);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure, true);
    };
  }, [active, measure]);

  if (!active || !def || !pos) {
    return null;
  }

  function advance() {
    const idx = STEP_ORDER.indexOf(step);
    setStep(STEP_ORDER[idx + 1] ?? "done");
  }

  return (
    <div
      className="fixed z-50 w-[320px] max-w-[calc(100vw-1.5rem)] rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl"
      style={{ top: pos.top, bottom: pos.bottom, left: pos.left }}
      role="dialog"
    >
      {/* Стрелка-указатель к кнопке */}
      <div
        className="absolute h-3 w-3 rotate-45 border-slate-200 bg-white"
        style={
          pos.arrowSide === "bottom"
            ? { bottom: -6, left: pos.arrowLeft - 6, borderRight: "1px solid", borderBottom: "1px solid" }
            : { top: -6, left: pos.arrowLeft - 6, borderLeft: "1px solid", borderTop: "1px solid" }
        }
        aria-hidden
      />
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
    </div>
  );
}
