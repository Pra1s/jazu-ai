"use client";

import { useEffect, useState } from "react";
import { ChevronDown, Clock, MapPin, Plus, X } from "lucide-react";
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
  restrictions: string;
};

const EMPTY: Fields = {
  companyName: "",
  services: "",
  links: "",
  pricing: "",
  script: "",
  restrictions: ""
};

// ── Конструктор филиалов ─────────────────────────────────────────────────────
// Каждая строка: адрес/охват + график (дни и часы). Сериализуется в текст
// branches (по строке на филиал) — формат API не меняется.

type BranchRow = {
  place: string;
  days: string; // ключ из DAY_OPTIONS, "" = не выбрано
  from: string;
  to: string;
};

const EMPTY_BRANCH: BranchRow = { place: "", days: "", from: "09:00", to: "18:00" };

const ROUND_THE_CLOCK = "Круглосуточно";
const DAY_OPTIONS = ["Пн-Пт", "Пн-Сб", "Ежедневно", "Сб-Вс", ROUND_THE_CLOCK];

// 00:00 … 23:30 с шагом 30 минут.
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => {
  const h = Math.floor(i / 2);
  const m = i % 2 === 0 ? "00" : "30";
  return `${String(h).padStart(2, "0")}:${m}`;
});

function serializeBranches(rows: BranchRow[]): string {
  return rows
    .map((r) => {
      const place = r.place.trim();
      if (!place) return "";
      if (r.days === ROUND_THE_CLOCK) return `${place} — круглосуточно`;
      if (r.days && r.from && r.to) return `${place} — ${r.days} ${r.from}–${r.to}`;
      return place;
    })
    .filter(Boolean)
    .join("\n");
}

// Best-effort парсинг сохранённого текста обратно в строки конструктора.
// Нераспознанные строки целиком уходят в поле адреса — юзер довыберет время.
function parseBranches(text: string): BranchRow[] {
  const rows = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): BranchRow => {
      const parts = line.split(/\s+[—–-]\s+/);
      if (parts.length >= 2) {
        const place = parts[0]!.trim();
        const rest = parts.slice(1).join(" — ").trim();
        if (/^круглосуточно$/i.test(rest)) {
          return { place, days: ROUND_THE_CLOCK, from: "", to: "" };
        }
        const m = rest.match(/^(.+?)\s+(\d{1,2}:\d{2})\s*[–—-]\s*(\d{1,2}:\d{2})$/);
        if (m) {
          const daysRaw = m[1]!.trim();
          const days =
            DAY_OPTIONS.find((d) => d.toLowerCase() === daysRaw.toLowerCase()) ??
            (/^ежедневно$/i.test(daysRaw) ? "Ежедневно" : "");
          const pad = (t: string) => (t.length === 4 ? `0${t}` : t);
          if (days) {
            return { place, days, from: pad(m[2]!), to: pad(m[3]!) };
          }
        }
      }
      return { ...EMPTY_BRANCH, place: line, days: "" };
    });
  return rows.length > 0 ? rows : [{ ...EMPTY_BRANCH }];
}

const FIELD_META: { key: keyof Fields; label: string; placeholder: string; rows: number }[] = [
  { key: "companyName", label: "Название компании", placeholder: "Например: Студия красоты «Алия»", rows: 1 },
  { key: "services", label: "Список услуг / товаров", placeholder: "Стрижка\nОкрашивание\nМаникюр", rows: 3 },
  { key: "links", label: "Ссылки (Instagram, 2ГИС, сайт)", placeholder: "https://instagram.com/...\nhttps://2gis.kz/...", rows: 2 },
  { key: "pricing", label: "Прайс / цены", placeholder: "Стрижка - 5000 ₸\nОкрашивание - от 15000 ₸", rows: 3 },
  { key: "script", label: "Скрипт / сценарий продаж", placeholder: "Как бот должен вести клиента к заявке", rows: 3 },
  { key: "restrictions", label: "Ограничения / чего не делаем", placeholder: "Не работаем с детьми до 18\nБез выезда за город", rows: 2 }
];

// Стилизованный селект: нативный select без системных стрелок + свой шеврон.
function StyledSelect({
  value,
  onChange,
  options,
  placeholder,
  ariaLabel,
  className
}: {
  value: string;
  onChange: (v: string) => void;
  options: string[];
  placeholder?: string;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className={cn(
          "w-full cursor-pointer appearance-none rounded-lg border border-border bg-background py-2 pl-3 pr-7 text-sm outline-none transition",
          "hover:border-foreground/30 focus:border-foreground focus:ring-1 focus:ring-foreground/10",
          value ? "text-foreground" : "text-muted-foreground"
        )}
      >
        {placeholder !== undefined && <option value="">{placeholder}</option>}
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}

// Структурированный ввод данных о бизнесе. Дополняет промпт, собранный чатом.
export default function ExtraDataDialog({ open, onClose, onSaved }: ExtraDataDialogProps) {
  const [fields, setFields] = useState<Fields>(EMPTY);
  const [branches, setBranches] = useState<BranchRow[]>([{ ...EMPTY_BRANCH }]);
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
        const branchesText = [hours, addresses !== hours ? addresses : ""].filter(Boolean).join("\n");
        setBranches(parseBranches(branchesText));
        setFields({
          companyName: typeof p.businessName === "string" ? p.businessName : "",
          services: Array.isArray(p.servicesList) ? (p.servicesList as string[]).join("\n") : "",
          links: "",
          pricing: typeof p.pricingPolicy === "string" ? p.pricingPolicy : "",
          script: "",
          restrictions: Array.isArray(p.notAllowed) ? (p.notAllowed as string[]).join("\n") : ""
        });
      } catch {
        setFields(EMPTY);
        setBranches([{ ...EMPTY_BRANCH }]);
      }
    })();
  }, [open]);

  function updateBranch(index: number, patch: Partial<BranchRow>) {
    setBranches((prev) => prev.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  }

  async function save() {
    setBusy(true);
    try {
      await apiJson("/agent/extra-data", {
        method: "POST",
        body: JSON.stringify({ ...fields, branches: serializeBranches(branches) })
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

          {/* Конструктор филиалов: адрес + график, связаны построчно. */}
          <div>
            <label className="block text-sm font-medium text-foreground">
              Адреса/филиалы и время работы
            </label>
            <div className="mt-1.5 space-y-2">
              {branches.map((row, i) => (
                <div
                  key={i}
                  className="group relative rounded-xl border border-border bg-secondary/30 p-2.5 transition hover:border-foreground/20"
                >
                  {branches.length > 1 && (
                    <button
                      type="button"
                      onClick={() => setBranches((prev) => prev.filter((_, j) => j !== i))}
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-sm transition hover:text-foreground"
                      aria-label="Удалить филиал"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="relative min-w-[11rem] flex-1">
                      <MapPin className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <input
                        type="text"
                        value={row.place}
                        onChange={(e) => updateBranch(i, { place: e.target.value })}
                        placeholder="Алматы, Самал-2, д.33"
                        className={cn(
                          "w-full rounded-lg border border-border bg-background py-2 pl-8 pr-3 text-sm text-foreground outline-none transition placeholder:text-muted-foreground",
                          "hover:border-foreground/30 focus:border-foreground focus:ring-1 focus:ring-foreground/10"
                        )}
                      />
                    </div>
                    {/* На мобилке ряд занимает всю ширину и селекты делят её
                        поровну (flex-1), на десктопе — компактные фиксированные. */}
                    <div className="flex w-full min-w-0 items-center gap-1.5 sm:w-auto">
                      <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      <StyledSelect
                        value={row.days}
                        onChange={(v) => updateBranch(i, { days: v })}
                        options={DAY_OPTIONS}
                        placeholder="Дни"
                        ariaLabel="Дни работы"
                        className="min-w-0 flex-1 sm:w-[8.5rem] sm:flex-none"
                      />
                      {row.days !== ROUND_THE_CLOCK && (
                        <>
                          <StyledSelect
                            value={row.from}
                            onChange={(v) => updateBranch(i, { from: v })}
                            options={TIME_OPTIONS}
                            ariaLabel="Время открытия"
                            className="min-w-0 flex-1 sm:w-[5.25rem] sm:flex-none"
                          />
                          <span className="shrink-0 text-xs text-muted-foreground">—</span>
                          <StyledSelect
                            value={row.to}
                            onChange={(v) => updateBranch(i, { to: v })}
                            options={TIME_OPTIONS}
                            ariaLabel="Время закрытия"
                            className="min-w-0 flex-1 sm:w-[5.25rem] sm:flex-none"
                          />
                        </>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() => setBranches((prev) => [...prev, { ...EMPTY_BRANCH }])}
              className="mt-2 flex items-center gap-1.5 text-sm font-medium text-brand transition hover:opacity-80"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded-full bg-brand/15">
                <Plus className="h-3.5 w-3.5" />
              </span>
              Добавить ещё один филиал
            </button>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Нет офиса или филиала? Укажите вместо адреса охват работы — например
              «Онлайн, вся РК», «Доставка по Алматы», «Выезд: Алматы и область» — и
              время, когда вы принимаете заявки.
            </p>
          </div>
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
