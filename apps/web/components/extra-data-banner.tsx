"use client";

import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, X } from "lucide-react";
import { businessProfileSchema, type BusinessProfile } from "@jazu/shared";
import { apiJson } from "@/lib/api";
import ExtraDataDialog from "@/components/extra-data-dialog";

// Глобальный баннер в кабинете: пока не заполнены ключевые данные о бизнесе,
// бот отвечает общими фразами. Показывается на всех страницах кабинета.
// Крестик скрывает баннер только в памяти (до перезагрузки страницы): пока
// данные не заполнены, при каждом новом заходе/обновлении алерт виден снова.
export default function ExtraDataBanner() {
  const [profile, setProfile] = useState<BusinessProfile | null>(null);
  const [hasPrompt, setHasPrompt] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [hidden, setHidden] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [promptData, progress] = await Promise.all([
        apiJson<{ businessProfile?: unknown }>("/agent/prompt"),
        apiJson<{ hasPrompt: boolean }>("/agent/progress")
      ]);
      setProfile(businessProfileSchema.parse(promptData.businessProfile ?? {}));
      setHasPrompt(progress.hasPrompt);
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    void refresh();
    // Промпт/профиль могли измениться из чата настройки или окна доп-данных.
    const onProgress = () => void refresh();
    window.addEventListener("jazu:promptProgress", onProgress);
    return () => window.removeEventListener("jazu:promptProgress", onProgress);
  }, [refresh]);


  // Каких ключевых данных не хватает — без них бот не знает конкретику бизнеса.
  const missing: string[] = [];
  if (profile) {
    if (!profile.businessName?.trim()) missing.push("название компании");
    if (profile.servicesList.length === 0) missing.push("услуги/товары");
    if (!profile.pricingPolicy?.trim()) missing.push("цены");
    if (!profile.hours?.trim() && !profile.addressPolicy?.trim()) {
      missing.push("адреса/филиалы и время работы");
    }
  }

  const show = profile !== null && hasPrompt && !hidden && missing.length > 0;

  return (
    <>
      {show && (
        <div className="border-b border-amber-300/60 bg-amber-50 px-4 py-2.5">
          <div className="mx-auto flex w-full max-w-3xl items-start gap-2.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
            <div className="min-w-0 flex-1 text-xs leading-5 text-amber-900">
              <span className="font-semibold">Заполните данные о бизнесе.</span>{" "}
              Сейчас бот отвечает общими фразами — ему не хватает точных данных вашего бизнеса:{" "}
              {missing.join(", ")}.
            </div>
            <button
              type="button"
              onClick={() => setDialogOpen(true)}
              className="shrink-0 rounded-full bg-amber-600 px-3 py-1 text-xs font-semibold text-white transition hover:bg-amber-700"
            >
              Заполнить
            </button>
            <button
              type="button"
              onClick={() => setHidden(true)}
              className="shrink-0 rounded-full p-1 text-amber-700/70 transition hover:bg-amber-100 hover:text-amber-900"
              aria-label="Скрыть"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      <ExtraDataDialog
        open={dialogOpen}
        onClose={() => setDialogOpen(false)}
        onSaved={() => {
          // Сообщаем остальным виджетам (чат, шапка), что профиль изменился,
          // и перечитываем его сами — баннер исчезнет, когда всё заполнено.
          window.dispatchEvent(new CustomEvent("jazu:promptProgress"));
          void refresh();
        }}
      />
    </>
  );
}
