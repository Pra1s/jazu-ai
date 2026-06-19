"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowDown,
  ArrowRight,
  Bot,
  ChevronDown,
  Clock,
  CreditCard,
  Flame,
  MessageCircle,
  MessageSquare,
  Moon,
  PencilLine,
  QrCode,
  Sparkles,
  Zap
} from "lucide-react";
import { apiJson, apiSse } from "@/lib/api";
import { type ActionButton } from "@jazu/shared";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { cn } from "@/lib/cn";
import { useAuthStatus } from "@/lib/use-auth-status";
import SiteFooter from "@/components/site-footer";
import { track, AnalyticsEvent } from "@/lib/analytics";
import { SUPPORT_WHATSAPP_URL } from "@/lib/support-whatsapp";

// Фирменный glyph WhatsApp (как в guest-header / side-nav)
function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z" />
    </svg>
  );
}

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

// Чипы доверия под полем (без повтора «тест бесплатно» из карточки)
const trustChips = [
  { icon: Clock, label: "Запуск за 5 минут" },
  { icon: CreditCard, label: "Без карты" },
  { icon: MessageCircle, label: "WhatsApp и Telegram" }
];

// Как это работает — реальный флоу платформы (4 шага)
const steps = [
  {
    icon: PencilLine,
    title: "Опишите бизнес",
    body: "Одно сообщение: чем занимаетесь и кого обслуживаете."
  },
  {
    icon: Sparkles,
    title: "AI соберёт промпт",
    body: "Задаст уточняющие вопросы по услугам, ценам и заявкам."
  },
  {
    icon: MessageSquare,
    title: "Тест с правками",
    body: "Поговорите с ботом от лица клиента и поправьте ответы прямо в чате."
  },
  {
    icon: QrCode,
    title: "Запуск в WhatsApp",
    body: "Сканируете QR — бот отвечает 24/7, горячие лиды летят на ваш номер."
  }
];

// Выгоды — результат для бизнеса, а не «фичи»
const benefits = [
  {
    icon: Moon,
    title: "Не теряете заявки 24/7",
    body: "Бот отвечает ночью и в выходные — ни одно сообщение не остаётся без ответа."
  },
  {
    icon: Flame,
    title: "Горячие лиды — сразу вам",
    body: "Квалифицирует клиента и присылает готовую заявку в WhatsApp или Telegram."
  },
  {
    icon: Bot,
    title: "Снимает рутину",
    body: "Сам отвечает на повторяющиеся вопросы про цены, услуги и часы работы."
  }
];

// Несколько примеров диалога для демо-мокапа (role: bot — ваша сторона).
// В ответах бота не используем длинное тире — только запятые / короткие паузы.
const demoConversations = [
  {
    title: "Оценка ущерба",
    messages: [
      { role: "client" as const, text: "Здравствуйте! Делаете оценку после затопления?" },
      {
        role: "bot" as const,
        text: "Здравствуйте! Да, оцениваем ущерб после затопления, пожара и ДТП. Что произошло и когда?"
      },
      { role: "client" as const, text: "Соседи сверху затопили вчера. Потолок и обои в зале." },
      {
        role: "bot" as const,
        text: "Понял. Подскажите адрес объекта и удобное время осмотра, передам мастеру."
      }
    ]
  },
  {
    title: "Доставка цветов",
    messages: [
      { role: "client" as const, text: "Можно букет к 18:00 сегодня?" },
      {
        role: "bot" as const,
        text: "Да, успеваем к 18:00. На какой адрес доставить и какой бюджет на букет?"
      },
      { role: "client" as const, text: "Розы, тысяч до 15. Адрес: Абая 25." },
      {
        role: "bot" as const,
        text: "Отлично, соберём букет роз до 15 000 ₸ к 18:00. Имя получателя и номер для связи?"
      }
    ]
  },
  {
    title: "Студия маникюра",
    messages: [
      { role: "client" as const, text: "Здравствуйте, есть окошко на маникюр завтра?" },
      {
        role: "bot" as const,
        text: "Здравствуйте! Завтра свободно в 12:00 и 17:30. Какое время удобнее?"
      },
      { role: "client" as const, text: "Давайте на 17:30." },
      {
        role: "bot" as const,
        text: "Записала на 17:30. Подскажите имя и номер, отправлю напоминание."
      }
    ]
  }
];

const faqs = [
  {
    q: "Нужен ли отдельный номер?",
    a: "Нет. Можно подключить ваш текущий WhatsApp по QR или завести отдельный номер — как удобнее."
  },
  {
    q: "На каких языках отвечает бот?",
    a: "На том, на котором пишет клиент: русский, казахский, английский и другие."
  },
  {
    q: "Сколько это стоит?",
    a: "Собрать и протестировать бота — бесплатно. Тарифы за работу показываем уже внутри, после теста."
  },
  {
    q: "Я контролирую, что отвечает бот?",
    a: "Да. Вы тестируете и правите ответы до запуска, а потом видите все диалоги."
  },
  {
    q: "Это сложно настроить?",
    a: "Нет. Опишите бизнес одним сообщением — остальное AI соберёт за несколько минут."
  }
];

// Карточка ввода — переиспользуется в hero и в финальном CTA.
// Вынесена из LandingClient и мемоизирована: typewriter живёт ВНУТРИ карточки,
// поэтому тики печати плейсхолдера перерисовывают только её, а не весь лендинг
// (раньше это вызывало лаги при скролле — печать шла каждые 30–60 мс).
const InputCard = memo(function InputCard({
  idSuffix,
  className,
  business,
  onChange,
  onStart,
  busy,
  error
}: {
  idSuffix: string;
  className?: string;
  business: string;
  onChange: (value: string) => void;
  onStart: () => void;
  busy: boolean;
  error: string | null;
}) {
  const empty = business.trim().length === 0;
  const typedExample = useTypewriter(PLACEHOLDER_EXAMPLES, empty);

  return (
    <div
      className={cn(
        "rounded-2xl border border-brand/40 bg-card p-4 shadow-[0_0_0_4px_hsl(var(--brand)/0.10),0_8px_30px_-12px_hsl(var(--brand)/0.35)] sm:p-5",
        className
      )}
    >
      <label htmlFor={`business-desc-${idSuffix}`} className="block text-sm font-medium text-foreground">
        Расскажите, чем занимается ваш бизнес
      </label>
      <textarea
        id={`business-desc-${idSuffix}`}
        value={business}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            onStart();
          }
        }}
        rows={5}
        className={cn(
          "mt-3 w-full resize-none rounded-xl border bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground",
          empty ? "animate-brand-border" : "border-brand/40",
          "focus:border-brand/60 focus:ring-2 focus:ring-[hsl(var(--brand)/0.18)]"
        )}
        placeholder={empty ? `Например: ${typedExample}▌` : "Например: доставка цветов по городу"}
      />
      <div className="mt-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Sparkles className="h-3.5 w-3.5 shrink-0 text-[#25D366]" />
          Тест бота бесплатно
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="brand" className="px-8" onClick={onStart} disabled={busy || empty}>
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
  );
});

export default function LandingClient() {
  const router = useRouter();
  const authStatus = useAuthStatus();
  const [business, setBusiness] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const empty = business.trim().length === 0;

  // Демо-блок: автопереключение примеров диалога
  const [activeDemo, setActiveDemo] = useState(0);
  useEffect(() => {
    const id = setInterval(
      () => setActiveDemo((i) => (i + 1) % demoConversations.length),
      5000
    );
    return () => clearInterval(id);
  }, []);
  const demo = demoConversations[activeDemo] ?? demoConversations[0];

  // Лендинг — только для гостей. Авторизованного сразу уводим в кабинет.
  useEffect(() => {
    if (authStatus?.ok === true) {
      router.replace("/dashboard");
    }
  }, [authStatus, router]);

  // Аналитика: landing_viewed — верх воронки привлечения. Шлём раз на визит,
  // только когда статус разрешился в «гость» (authStatus.ok === false):
  // авторизованных тут не считаем — их редиректит в кабинет, это не вход в
  // воронку. Ref — чтобы не задвоить при ре-рендерах в рамках одного визита.
  const landingViewedFiredRef = useRef(false);
  useEffect(() => {
    if (authStatus?.ok === false && !landingViewedFiredRef.current) {
      landingViewedFiredRef.current = true;
      track(AnalyticsEvent.LandingViewed);
    }
  }, [authStatus]);

  const start = useCallback(async () => {
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
  }, [business, busy, router]);

  const handleChange = useCallback((value: string) => setBusiness(value), []);

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
      <InputCard
        idSuffix="hero"
        className="mt-3"
        business={business}
        onChange={handleChange}
        onStart={start}
        busy={busy}
        error={error}
      />

      {/* Чипы доверия */}
      <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
        {trustChips.map(({ icon: Icon, label }) => (
          <span
            key={label}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5 text-xs font-medium text-muted-foreground"
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-[#25D366]" />
            {label}
          </span>
        ))}
      </div>

      {/* Как это работает */}
      <section className="mt-16 cv-auto sm:mt-24">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Как это работает
        </h2>
        <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">
          От описания бизнеса до бота в WhatsApp — за несколько минут.
        </p>
        <div className="mt-8 grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-4">
          {steps.map(({ icon: Icon, title, body }, i) => (
            <div key={title} className="rounded-xl border border-border bg-card p-4">
              <div className="flex items-center justify-between">
                <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-brand/10 text-brand">
                  <Icon className="h-4 w-4" />
                </div>
                <span className="text-sm font-semibold text-[hsl(var(--muted-foreground)/0.45)]">{`0${i + 1}`}</span>
              </div>
              <h3 className="mt-3 text-sm font-semibold text-foreground">{title}</h3>
              <p className="mt-1 text-xs leading-5 text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Демо: как отвечает бот (статичный мокап) */}
      <section className="mt-16 cv-auto sm:mt-24">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Как отвечает бот
        </h2>
        <p className="mx-auto mt-2 max-w-md text-center text-sm text-muted-foreground">
          Расспрашивает клиента и отдаёт готовую заявку вам — без вашего участия.
        </p>
        <div className="mx-auto mt-8 max-w-md overflow-hidden rounded-2xl border border-border shadow-sm">
          <div className="flex items-center gap-3 border-b border-border bg-card px-4 py-3">
            <div className="flex h-9 w-9 items-center justify-center rounded-full bg-[#25D366]/15 text-[#25D366]">
              <Bot className="h-4 w-4" />
            </div>
            <div className="leading-tight">
              <div key={activeDemo} className="animate-demo-fade text-sm font-medium text-foreground">
                {demo?.title} · бот
              </div>
              <div className="text-xs text-[#25D366]">в сети</div>
            </div>
          </div>
          <div key={activeDemo} className="animate-demo-fade space-y-2.5 bg-test-canvas px-3 py-4">
            {(demo?.messages ?? []).map((m) => (
              <div key={m.text} className={cn("flex", m.role === "bot" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-3 py-2 text-sm leading-snug text-foreground shadow-sm",
                    m.role === "bot" ? "rounded-br-sm bg-[#D9FDD3]" : "rounded-bl-sm bg-card"
                  )}
                >
                  {m.text}
                </div>
              </div>
            ))}
            <div className="flex justify-center pt-1">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
                <Flame className="h-3.5 w-3.5 text-[#25D366]" />
                Горячий лид отправлен на ваш WhatsApp
              </span>
            </div>
          </div>
        </div>

        {/* Прогресс-индикаторы примеров (активный плавно заливается) */}
        <div key={activeDemo} className="mt-5 flex items-center justify-center gap-2">
          {demoConversations.map((c, i) => (
            <button
              key={c.title}
              type="button"
              onClick={() => setActiveDemo(i)}
              aria-label={`Пример: ${c.title}`}
              aria-current={i === activeDemo}
              className="h-1.5 w-8 overflow-hidden rounded-full bg-[hsl(var(--foreground)/0.12)] transition-colors hover:bg-[hsl(var(--foreground)/0.2)] sm:w-10"
            >
              <span
                className={cn(
                  "block h-full rounded-full bg-brand",
                  i === activeDemo ? "w-full animate-indicator-fill" : "w-0"
                )}
              />
            </button>
          ))}
        </div>
      </section>

      {/* Выгоды */}
      <section className="mt-16 cv-auto sm:mt-24">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Почему это работает
        </h2>
        <div className="mt-8 grid gap-3 sm:grid-cols-3 sm:gap-5">
          {benefits.map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-xl border border-border bg-card p-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary">
                <Icon className="h-4 w-4 text-foreground" />
              </div>
              <h3 className="mt-3 text-sm font-semibold text-foreground">{title}</h3>
              <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{body}</p>
            </div>
          ))}
        </div>
      </section>

      {/* FAQ */}
      <section className="mt-16 cv-auto sm:mt-24">
        <h2 className="text-center text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
          Частые вопросы
        </h2>
        <div className="mx-auto mt-8 max-w-xl overflow-hidden rounded-2xl border border-border bg-card">
          {faqs.map(({ q, a }) => (
            <details key={q} className="group border-b border-border px-4 last:border-b-0 sm:px-5">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-4 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
                {q}
                <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
              </summary>
              <p className="pb-4 text-sm leading-6 text-muted-foreground">{a}</p>
            </details>
          ))}
        </div>

        {/* Не нашли ответ — пишите в поддержку WhatsApp */}
        <div className="mx-auto mt-5 flex max-w-xl flex-col items-center gap-3 rounded-2xl border border-border bg-card px-4 py-5 text-center sm:flex-row sm:justify-between sm:gap-4 sm:px-6 sm:text-left">
          <p className="text-sm text-muted-foreground">
            Остались вопросы или что-то непонятно? Напишите нам — поможем.
          </p>
          <a
            href={SUPPORT_WHATSAPP_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex shrink-0 items-center gap-2 rounded-full bg-[#25D366] px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-[#1ebe5c]"
          >
            <WhatsAppIcon className="h-4 w-4" />
            Написать в WhatsApp
          </a>
        </div>
      </section>

      {/* Финальный CTA — дублируем блок ввода */}
      <section className="mt-16 cv-auto sm:mt-24">
        <div className="rounded-3xl border border-border bg-secondary px-4 py-10 text-center sm:px-8 sm:py-14">
          <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            Соберите AI-менеджера за 5 минут
          </h2>
          <p className="mx-auto mt-2 max-w-md text-sm text-muted-foreground">
            Опишите бизнес и протестируйте ответы бесплатно — без карты.
          </p>
          <div className="mx-auto mt-6 max-w-2xl text-left">
            <InputCard
              idSuffix="cta"
              business={business}
              onChange={handleChange}
              onStart={start}
              busy={busy}
              error={error}
            />
          </div>
        </div>
      </section>

      <SiteFooter className="mt-12 sm:mt-16" />
    </div>
  );
}
