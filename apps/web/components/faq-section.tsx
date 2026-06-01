"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

const FAQ: { q: string; a: string }[] = [
  {
    q: "Что считается одним диалогом?",
    a: "Один уникальный клиент в течение месяца. Сколько бы сообщений он ни написал, это один диалог. В новом месяце тот же клиент считается заново."
  },
  {
    q: "Что будет, когда диалоги закончатся?",
    a: "Бот перестанет отвечать новым клиентам. Чтобы продолжить, докупите диалоги по цене вашего тарифа или дождитесь продления."
  },
  {
    q: "Как продлить тариф?",
    a: "Продление и докупка диалогов делаются вручную в этом разделе. Авто-списаний нет, вы платите, когда сами решите продлить."
  },
  {
    q: "Чем отличается докупка от смены тарифа?",
    a: "Докупка добавляет диалоги к текущему балансу по цене вашего тарифа. Смена тарифа задаёт новый месячный лимит и цену за диалог."
  },
  {
    q: "Настройка и тест бота платные?",
    a: "Нет. Сборка промпта и тестовый чат полностью бесплатны. Диалоги списываются только когда бот общается с реальными клиентами в WhatsApp."
  },
  {
    q: "Как оплатить?",
    a: "Оплата проходит через Kaspi Pay. После оплаты лимит диалогов и срок тарифа обновятся автоматически."
  }
];

export default function FaqSection() {
  const [open, setOpen] = useState<number | null>(null);
  return (
    <section className="mt-16 border-t border-border pt-10">
      <h2 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
        Частые вопросы
      </h2>
      <div className="mt-6 space-y-2">
        {FAQ.map((item, i) => (
          <div key={item.q} className="rounded-xl border border-border bg-card">
            <button
              type="button"
              onClick={() => setOpen(open === i ? null : i)}
              className="flex w-full items-center justify-between gap-3 px-4 py-3.5 text-left"
              aria-expanded={open === i}
            >
              <span className="text-sm font-medium text-foreground">{item.q}</span>
              <ChevronDown
                className={cn(
                  "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                  open === i && "rotate-180"
                )}
              />
            </button>
            {open === i && (
              <div className="border-t border-border px-4 py-3 text-sm leading-6 text-muted-foreground">
                {item.a}
              </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}
