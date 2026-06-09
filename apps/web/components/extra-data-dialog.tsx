"use client";

import { useEffect, useState } from "react";
import { apiJson } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { toast } from "sonner";

type ExtraDataDialogProps = {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
};

type Fields = {
  companyName: string;
  services: string;
  links: string;
  pricing: string;
  script: string;
  branches: string;
  restrictions: string;
};

const EMPTY: Fields = {
  companyName: "",
  services: "",
  links: "",
  pricing: "",
  script: "",
  branches: "",
  restrictions: ""
};

const FIELD_META: { key: keyof Fields; label: string; placeholder: string; rows: number }[] = [
  { key: "companyName", label: "Название компании", placeholder: "Например: Студия красоты «Алия»", rows: 1 },
  { key: "services", label: "Список услуг / товаров", placeholder: "Стрижка\nОкрашивание\nМаникюр", rows: 3 },
  { key: "links", label: "Ссылки (Instagram, 2ГИС, сайт)", placeholder: "https://instagram.com/...\nhttps://2gis.kz/...", rows: 2 },
  { key: "pricing", label: "Прайс / цены", placeholder: "Стрижка - 5000 ₸\nОкрашивание - от 15000 ₸", rows: 3 },
  { key: "script", label: "Скрипт / сценарий продаж", placeholder: "Как бот должен вести клиента к заявке", rows: 3 },
  {
    key: "branches",
    label: "Адреса/филиалы и время работы",
    placeholder: "Филиал 1, ул. Абая 10 — Пн-Пт 9:00–20:00\nФилиал 2, ул. Достык 5 — ежедневно 10:00–22:00",
    rows: 3
  },
  { key: "restrictions", label: "Ограничения / чего не делаем", placeholder: "Не работаем с детьми до 18\nБез выезда за город", rows: 2 }
];

// Структурированный ввод данных о бизнесе. Дополняет промпт, собранный чатом.
export default function ExtraDataDialog({ open, onClose, onSaved }: ExtraDataDialogProps) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [busy, setBusy] = useState(false);

  // Подтягиваем уже сохранённые значения из профиля при открытии.
  useEffect(() => {
    if (!open) return;
    void (async () => {
      try {
        const data = await apiJson<{ businessProfile?: Record<string, unknown> }>("/agent/prompt");
        const p = data.businessProfile ?? {};
        // Филиалы и график живут одним полем (profile.hours). Старые адреса из
        // addressPolicy подмешиваем в префилл, чтобы при сохранении они
        // переехали в объединённое поле.
        const hours = typeof p.hours === "string" ? p.hours.trim() : "";
        const addresses = typeof p.addressPolicy === "string" ? p.addressPolicy.trim() : "";
        const branches = [hours, addresses !== hours ? addresses : ""].filter(Boolean).join("\n");
        setFields({
          companyName: typeof p.businessName === "string" ? p.businessName : "",
          services: Array.isArray(p.servicesList) ? (p.servicesList as string[]).join("\n") : "",
          links: "",
          pricing: typeof p.pricingPolicy === "string" ? p.pricingPolicy : "",
          script: "",
          branches,
          restrictions: Array.isArray(p.notAllowed) ? (p.notAllowed as string[]).join("\n") : ""
        });
      } catch {
        setFields(EMPTY);
      }
    })();
  }, [open]);

  async function save() {
    setBusy(true);
    try {
      await apiJson("/agent/extra-data", {
        method: "POST",
        body: JSON.stringify(fields)
      });
      toast.success("Данные сохранены, бот будет их использовать");
      onSaved?.();
      onClose();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось сохранить");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Данные о бизнесе</DialogTitle>
          <DialogDescription>
            Добавьте детали, бот будет использовать их в ответах клиентам.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {FIELD_META.map((f) => (
            <div key={f.key}>
              <label className="block text-sm font-medium text-foreground">{f.label}</label>
              <textarea
                rows={f.rows}
                value={fields[f.key]}
                onChange={(e) => setFields((prev) => ({ ...prev, [f.key]: e.target.value }))}
                placeholder={f.placeholder}
                className={cn(
                  "mt-1.5 w-full resize-none rounded-lg border border-border bg-background px-3.5 py-2.5 text-sm text-foreground outline-none transition placeholder:text-muted-foreground",
                  "focus:border-foreground focus:ring-1 focus:ring-foreground/10"
                )}
              />
            </div>
          ))}
        </div>

        <div className="mt-2 flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Отмена
          </Button>
          <Button onClick={() => void save()} disabled={busy}>
            {busy ? "Сохраняем…" : "Сохранить"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
