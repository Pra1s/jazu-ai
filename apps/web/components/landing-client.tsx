"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowRight, Bot, MessageSquare, Sparkles, Zap } from "lucide-react";
import { apiJson, apiSse } from "@/lib/api";
import { type ActionButton } from "@jazu/shared";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { cn } from "@/lib/cn";
import { useAuthStatus } from "@/lib/use-auth-status";
import SiteFooter from "@/components/site-footer";
import { track, AnalyticsEvent } from "@/lib/analytics";

type BuilderTurn = {
  assistantText: string;
  promptDraft?: string;
  actionButton?: ActionButton;
  readyToTest?: boolean;
};

// Короткие примеры ниш для печатной анимации в плейсхолдере
const PLACEHOLDER_EXAMPLES = [
  "Доставка цветов по городу",
  "Студия маникюра и бровей",
  "Ремонт квартир под ключ",
  "Онлайн-школа английского"
];

// Печатает примеры по одному: набор → пауза → стирание → следующий.
function useTypewriter(words: string[], enabled: boolean) {
  const [text, setText] = useState("");

  useEffect(() => {
    if (!enabled) {
      setText("");
      return;
    }
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      setText(words[0] ?? "");
      return;
    }

    let wordIdx = 0;
    let charIdx = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;

    const tick = () => {
      const word = words[wordIdx] ?? "";
      if (!deleting) {
        charIdx += 1;
        setText(word.slice(0, charIdx));
        if (charIdx === word.length) {
          deleting = true;
          timer = setTimeout(tick, 1700);
          return;
        }
        timer = setTimeout(tick, 60);
      } else {
        charIdx -= 1;
        setText(word.slice(0, charIdx));
        if (charIdx === 0) {
          deleting = false;
          wordIdx = (wordIdx + 1) % words.length;
          timer = setTimeout(tick, 350);
          return;
        }
        timer = setTimeout(tick, 30);
      }
    };

    timer = setTimeout(tick, 450);
    return () => clearTimeout(timer);
  }, [enabled, words]);

  return text;
}

const features = [
  {
    icon: Bot,
    title: "Глубокий опрос бизнеса",
    body: "AI задаёт точечные вопросы по нише, услугам, ценам, заявкам и ограничениям и сам собирает промпт."
  },
  {
    icon: MessageSquare,
    title: "Тест с правками",
    body: "Проверьте ответы от лица клиента. Нажмите «Поправить» на любой реплике, промпт обновится."
  },
  {
    icon: Zap,
    title: "WhatsApp по QR",
    body: "Отсканируйте QR, и агент начнёт отвечать клиентам 24/7. Горячие лиды на ваш номер WhatsApp или в Telegram."
  }
];

export default function LandingClient() {
  const router = useRouter();
  const authStatus = useAuthStatus();
  const [business, setBusiness] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = business.trim().length === 0;
  const typedExample = useTypewriter(PLACEHOLDER_EXAMPLES, empty);

  // Лендинг — только для гостей. Авторизованного сразу уводим в кабинет.
  useEffect(() => {
    if (authStatus?.ok === true) {
      router.replace("/dashboard");
    }
  }, [authStatus, router]);

  async function start() {
    if (!business.trim() || busy) return;
    setBusy(true);
    setError(null);
    // Первый осознанный шаг воронки: пользователь начал собирать бота.
    track(AnalyticsEvent.BuilderStarted);
    try {
      await apiJson("/session", { method: "POST" });
      await apiSse<BuilderTurn>("/agent/chat", { message: business.trim() });
      router.push("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Что-то пошло не так");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      {/* Hero */}
      <div className="pt-4 text-center sm:pt-10">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground sm:mb-5">
          <Zap className="h-3 w-3" />
          AI-менеджер для WhatsApp
        </div>

        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-5xl">
          Бот, который понимает
          <br />
          <span className="text-muted-foreground">ваш бизнес</span>
        </h1>

        <p className="mx-auto mt-4 max-w-xl text-sm leading-6 text-muted-foreground sm:mt-5 sm:text-base sm:leading-7">
          Опишите компанию в одном сообщении. Система задаст уточняющие вопросы,
          соберёт промпт и позволит протестировать ответы за несколько минут.
        </p>
      </div>

      {/* Cue: пока поле пустое — подсказываем, что писать нужно именно сюда */}
      <div
        className={cn(
          "mt-6 flex justify-center transition-all duration-300 sm:mt-10",
          empty ? "opacity-100" : "pointer-events-none h-0 -translate-y-1 overflow-hidden opacity-0"
        )}
        aria-hidden={!empty}
      >
        <div className="inline-flex items-center gap-2 rounded-full border border-brand/30 bg-brand/10 px-3.5 py-1.5 text-xs font-medium text-brand">
          <Sparkles className="h-3.5 w-3.5" />
          Начните здесь — опишите бизнес
          <ArrowDown className="h-3.5 w-3.5 animate-bounce" />
        </div>
      </div>

      {/* Input — brand-обводка и свечение остаются и после начала ввода */}
      <div className="mt-3 rounded-2xl border border-brand/40 bg-card p-4 shadow-[0_0_0_4px_hsl(var(--brand)/0.10),0_8px_30px_-12px_hsl(var(--brand)/0.35)] sm:p-5">
        <label htmlFor="business-desc" className="block text-sm font-medium text-foreground">
          Расскажите, чем занимается ваш бизнес
        </label>
        <textarea
          id="business-desc"
          value={business}
          onChange={(e) => setBusiness(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              void start();
            }
          }}
          rows={5}
          className={cn(
            "mt-3 w-full resize-none rounded-xl border bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground",
            empty ? "animate-brand-border" : "border-brand/40",
            "focus:border-brand/60 focus:ring-2 focus:ring-[hsl(var(--brand)/0.18)]"
          )}
          placeholder={
            empty
              ? `Например: ${typedExample}▌`
              : "Например: доставка цветов по городу"
          }
        />
        <div className="mt-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Sparkles className="h-3.5 w-3.5 shrink-0 text-[#25D366]" />
            Тест бота бесплатно
          </div>
          <div className="flex shrink-0 gap-2">
            <Button
              variant="brand"
              className="px-8"
              onClick={() => void start()}
              disabled={busy || !business.trim()}
            >
              {busy ? "Создаю промпт…" : "Начать"}
              {!busy && <ArrowRight className="h-4 w-4" />}
            </Button>
          </div>
        </div>

        {error && (
          <FormAlert variant="error" className="mt-3">
            {error}
          </FormAlert>
        )}
      </div>

      {/* Features */}
      <div className="mt-10 grid gap-3 sm:mt-14 sm:grid-cols-3 sm:gap-5">
        {features.map(({ icon: Icon, title, body }) => (
          <div key={title} className="rounded-xl border border-border bg-card p-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-secondary">
              <Icon className="h-4 w-4 text-foreground" />
            </div>
            <h3 className="mt-3 text-sm font-semibold text-foreground">{title}</h3>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{body}</p>
          </div>
        ))}
      </div>

      <SiteFooter className="mt-12 sm:mt-16" />
    </div>
  );
}
