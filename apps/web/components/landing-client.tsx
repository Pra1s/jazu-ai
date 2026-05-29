"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, Bot, MessageSquare, Zap } from "lucide-react";
import { apiJson, apiSse } from "@/lib/api";
import { type ActionButton } from "@jazu/shared";
import { Button } from "@/components/ui/button";
import { FormAlert } from "@/components/ui/form-alert";
import { cn } from "@/lib/cn";

type BuilderTurn = {
  assistantText: string;
  promptDraft?: string;
  actionButton?: ActionButton;
  readyToTest?: boolean;
};

const features = [
  {
    icon: Bot,
    title: "Глубокий опрос бизнеса",
    body: "AI задаёт точечные вопросы по нише, услугам, ценам, заявкам и ограничениям — и сам собирает промпт."
  },
  {
    icon: MessageSquare,
    title: "Тест с правками",
    body: "Проверьте ответы от лица клиента. Нажмите «Поправить» на любой реплике — промпт обновится."
  },
  {
    icon: Zap,
    title: "WhatsApp по QR",
    body: "Отсканируйте QR — и агент начнёт отвечать клиентам 24/7. Горячие лиды — на ваш номер WhatsApp или в Telegram."
  }
];

export default function LandingClient() {
  const router = useRouter();
  const [business, setBusiness] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start() {
    if (!business.trim() || busy) return;
    setBusy(true);
    setError(null);
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

      {/* Input */}
      <div className="mt-6 rounded-2xl border border-border bg-card p-4 shadow-sm sm:mt-10 sm:p-5">
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
            "mt-3 w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm leading-6 text-foreground outline-none transition placeholder:text-muted-foreground",
            "focus:border-foreground focus:ring-1 focus:ring-foreground/20"
          )}
          placeholder="Например: мы занимаемся оценкой ущерба после ДТП, пожара и затопления. Нужен бот, который подробно расспрашивает клиента и передаёт горячие заявки."
        />
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            ⌘+Enter для отправки
          </div>
          <div className="flex gap-2">
            <Button
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

      {/* Footer */}
      <footer className="mt-12 border-t border-border pt-6 pb-6 sm:mt-16">
        <div className="flex flex-col items-center gap-3 text-center">
          <p className="text-xs text-muted-foreground">
            © {new Date().getFullYear()} Jazu · ТОО «FINTECH IT»
          </p>
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
            {[
              { href: "/legal/oferta", label: "Публичный договор-оферта" },
              { href: "/legal/usloviya", label: "Условия использования" },
              { href: "/legal/politika", label: "Политика конфиденциальности" }
            ].map((link) => (
              <a
                key={link.href}
                href={link.href}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
      </footer>
    </div>
  );
}
