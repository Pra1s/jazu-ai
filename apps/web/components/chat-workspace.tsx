"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronRight, Send, RotateCcw, Mic, Pencil, Play, FileText, Smartphone } from "lucide-react";
import {
  type ActionButton,
  type BusinessProfile,
  type ChatMessage,
  type PromptCard,
  businessProfileSchema
} from "@jazu/shared";
import { apiJson, apiSse } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription
} from "@/components/ui/dialog";
import { cn } from "@/lib/cn";
import { renderMarkdown } from "@/lib/render-markdown";
import { toast } from "sonner";
import { useAuthStatus } from "@/lib/use-auth-status";
import ExtraDataDialog from "@/components/extra-data-dialog";

type AssistantPart = {
  type: string;
  text?: string;
  action_button?: ActionButton;
  prompt_card?: PromptCard;
};

type HandoffType = "hot_lead" | "complaint" | "out_of_scope" | "requested" | null;

type TurnResponse = {
  assistantText?: string;
  reply?: string;
  promptDraft?: string;
  actionButton?: ActionButton;
  readyToTest?: boolean;
  nextQuestions?: string[];
  shouldHandoff?: boolean;
  handoffType?: HandoffType;
  summary?: string;
  assistantParts?: AssistantPart[];
  promptCard?: PromptCard;
};

type PromptResponse = {
  prompt: string;
  businessProfile: BusinessProfile;
};

type Mode = "setup" | "test";

type CorrectionState = {
  messageId: string;
  text: string;
};

function normalize(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => ({ ...m, parts: Array.isArray(m.parts) ? m.parts : [] }));
}

// Уведомляем гостевую шапку (GuestHeader), что промпт/правки могли
// измениться — она перечитает /agent/progress и решит, показывать ли CTA
// «Привязать WhatsApp».
function notifyPromptProgress() {
  window.dispatchEvent(new CustomEvent("jazu:promptProgress"));
}

function getActionButton(parts: ChatMessage["parts"]): ActionButton | undefined {
  return parts.find(
    (p): p is { type: string; action_button: ActionButton } =>
      typeof p === "object" && "action_button" in p && Boolean((p as { action_button?: unknown }).action_button)
  )?.action_button;
}

function getPromptCard(parts: ChatMessage["parts"]): PromptCard | undefined {
  const part = parts.find(
    (p): p is { type: string; prompt_card: PromptCard } =>
      typeof p === "object" && "prompt_card" in p && Boolean((p as { prompt_card?: unknown }).prompt_card)
  );
  return part?.prompt_card;
}

function isStale(parts: ChatMessage["parts"]): boolean {
  return parts.some(
    (p) =>
      typeof p === "object" &&
      ((p as { type?: string }).type === "stale_marker" ||
        (p as { stale?: boolean }).stale === true)
  );
}

const correctionTypeLabel: Record<string, string> = {
  tone: "Тон",
  scenario: "Сценарий",
  restriction: "Запрет",
  fact: "Факт",
  handoff: "Передача",
  objection: "Возражение",
  multi: "Несколько правил",
  other: "Другое"
};

function PromptCardInline({ card, animate = false }: { card: PromptCard; animate?: boolean }) {
  const isCorrection = card.kind === "correction" || card.changeKind === "correction";
  const isCreate = card.changeKind === "create";
  const isEdit = !isCreate && !isCorrection;
  const isEdits = card.kind === "edits" || isCorrection;
  // Свёрнуто по умолчанию для всех типов: главное — summary, а полный промпт по клику.
  const [open, setOpen] = useState(false);
  const [typedCount, setTypedCount] = useState(animate ? 0 : card.prompt.length);
  const [isTyping, setIsTyping] = useState(animate);
  const addedSet = useMemo(() => new Set(card.addedLines.map((l) => l.trimEnd())), [card.addedLines]);
  const removedSet = useMemo(
    () => new Set((card.removedLines ?? []).map((l) => l.trimEnd())),
    [card.removedLines]
  );

  useEffect(() => {
    if (!animate) {
      setTypedCount(card.prompt.length);
      setIsTyping(false);
      return;
    }
    setTypedCount(0);
    setIsTyping(true);
    const total = card.prompt.length;
    const totalMs = Math.min(2600, Math.max(900, total * 3));
    const stepMs = 24;
    const perStep = Math.max(4, Math.ceil(total / Math.max(1, Math.round(totalMs / stepMs))));
    let current = 0;
    const interval = window.setInterval(() => {
      current = Math.min(total, current + perStep);
      setTypedCount(current);
      if (current >= total) {
        window.clearInterval(interval);
        setIsTyping(false);
      }
    }, stepMs);
    return () => window.clearInterval(interval);
  }, [animate, card.prompt]);

  const label = isCorrection
    ? "Промпт обновлён"
    : isCreate
    ? "Создание"
    : isEdit
    ? "Правка"
    : isEdits
    ? "Правки"
    : "Обновление";
  const badge = isCorrection
    ? card.editsCount > 0
      ? `· ${card.editsCount} изм.`
      : "· применено"
    : isCreate
    ? `· ${card.charCount} симв.`
    : isEdit
    ? ""
    : isEdits
    ? `· ${card.editsCount}`
    : `· ${card.charCount} симв.`;
  const visiblePrompt = card.prompt.slice(0, typedCount);

  return (
    <div
      className={cn(
        "my-1 rounded-lg border",
        isCorrection
          ? "border-emerald-300/70 bg-emerald-50/70"
          : "border-border bg-secondary/40"
      )}
    >
      <button
        type="button"
        className="flex w-full items-center gap-2 px-3 py-2 text-left"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
      >
        {isCorrection ? (
          <Pencil className="h-3.5 w-3.5 text-emerald-700" />
        ) : isEdits ? (
          <Pencil className="h-3.5 w-3.5 text-brand" />
        ) : (
          <FileText className="h-3.5 w-3.5 text-brand" />
        )}
        <span
          className={cn(
            "text-xs font-medium",
            isCorrection ? "text-emerald-900" : "text-foreground"
          )}
        >
          {label}
        </span>
        <span
          className={cn(
            "text-xs",
            isCorrection ? "text-emerald-800/80" : "text-muted-foreground"
          )}
        >
          {badge}
        </span>
        {isTyping && (
          <span className="text-xs italic text-muted-foreground">печатаю…</span>
        )}
        <span className="ml-auto text-muted-foreground">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>

      {isCorrection && (card.correctionType || card.sectionEdited) && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-emerald-200/70 px-3 py-2">
          {card.correctionType && correctionTypeLabel[card.correctionType] && (
            <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800">
              {correctionTypeLabel[card.correctionType]}
            </span>
          )}
          {card.sectionEdited && (
            <span className="text-[11px] text-emerald-800/80">{card.sectionEdited}</span>
          )}
        </div>
      )}
      {isCorrection && card.changeSummary && (
        <div className="border-t border-emerald-200/70 px-3 py-2 text-xs leading-5 text-emerald-900">
          {card.changeSummary}
        </div>
      )}
      {!isCorrection && card.changeSummary && (
        <div className="border-t border-border/70 px-3 py-2 text-xs leading-5 text-foreground/80">
          {card.changeSummary}
        </div>
      )}

      {open && (
        <div
          className={cn(
            "border-t px-2 py-3 sm:px-3",
            isCorrection ? "border-emerald-200/70 bg-white/70" : "border-border bg-card/80"
          )}
        >
          {isCorrection && card.removedLines && card.removedLines.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-rose-700/80">
                Удалено
              </div>
              <pre className="scrollbar-hide max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-rose-50 px-3 py-2 font-mono text-[11.5px] leading-5 text-rose-900">
                {card.removedLines.join("\n")}
              </pre>
            </div>
          )}
          {isCorrection && card.addedLines.length > 0 && (
            <div className="mb-2">
              <div className="mb-1 text-[10.5px] font-medium uppercase tracking-wide text-emerald-700/80">
                Добавлено
              </div>
              <pre className="scrollbar-hide max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-emerald-50 px-3 py-2 font-mono text-[11.5px] leading-5 text-emerald-900">
                {card.addedLines.join("\n")}
              </pre>
            </div>
          )}
          <details className={cn(isCorrection && "mt-2")}>
            <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground">
              {isCorrection ? "Показать весь промпт" : "Свернуть промпт"}
            </summary>
            <pre className="scrollbar-hide mt-2 max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md bg-secondary px-3 py-3 font-mono text-[11.5px] leading-5 text-foreground sm:text-[12px]">
              {visiblePrompt.split("\n").map((line, idx, arr) => {
                const trimmed = line.trimEnd();
                const isAdded = isEdits && trimmed.length > 0 && addedSet.has(trimmed);
                const isRemoved = isCorrection && trimmed.length > 0 && removedSet.has(trimmed);
                const isLast = idx === arr.length - 1;
                return (
                  <span
                    key={idx}
                    className={cn(
                      "block px-1.5 -mx-1.5 rounded",
                      isAdded && "bg-emerald-200/60",
                      isRemoved && "bg-rose-200/50 line-through"
                    )}
                  >
                    {line || "\u00a0"}
                    {isTyping && isLast && (
                      <span className="ml-0.5 inline-block h-3 w-[2px] animate-pulse bg-foreground/70 align-middle" />
                    )}
                  </span>
                );
              })}
            </pre>
          </details>
        </div>
      )}
    </div>
  );
}

function MessageRow({
  message,
  mode,
  onCorrect,
  isStreaming = false,
  animatePromptCard = false
}: {
  message: ChatMessage;
  mode: Mode;
  onCorrect?: (m: ChatMessage) => void;
  isStreaming?: boolean;
  animatePromptCard?: boolean;
}) {
  const isUser = message.role === "user";
  const actionButton = getActionButton(message.parts);
  const promptCard = !isUser ? getPromptCard(message.parts) : undefined;
  const stale = !isUser && isStale(message.parts);

  if (isUser) {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-brand/15 px-4 py-2.5 text-[15px] leading-relaxed text-foreground">
          <span className="whitespace-pre-wrap">{message.content}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        className={cn(
          "max-w-full text-[15px] leading-relaxed",
          stale ? "text-muted-foreground/70" : "text-foreground"
        )}
      >
        {message.content ? (
          <div className={cn("prose-tight", stale && "line-through decoration-muted-foreground/40")}>
            {renderMarkdown(message.content)}
            {isStreaming && (
              <span className="ml-0.5 inline-block h-4 w-0.5 animate-pulse bg-foreground/70 align-middle" />
            )}
          </div>
        ) : (
          isStreaming && (
            <span className="inline-block h-4 w-0.5 animate-pulse bg-foreground/70" />
          )
        )}
        {stale && (
          <div className="mt-1 text-[11px] text-muted-foreground/80">было до правки промпта</div>
        )}
      </div>

      {promptCard && !isStreaming && (
        <PromptCardInline card={promptCard} animate={animatePromptCard} />
      )}

      {actionButton && !isStreaming && (
        <div>
          <Button
            size="sm"
            onClick={() => {
              if (actionButton.type === "switch_to_test") {
                window.dispatchEvent(new CustomEvent("jazu:switchToTest"));
              }
            }}
            className="gap-1.5 rounded-full bg-[#25D366] px-4 py-2 text-sm font-semibold text-white shadow-md shadow-[#25D366]/25 transition hover:bg-[#1ebe5c] hover:shadow-[#25D366]/35 active:scale-95"
          >
            <Play className="h-3.5 w-3.5 fill-current" />
            {actionButton.label}
          </Button>
        </div>
      )}

      {mode === "test" && !isStreaming && !stale && onCorrect && (
        <button
          type="button"
          onClick={() => onCorrect(message)}
          className="self-start text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        >
          Поправить
        </button>
      )}
    </div>
  );
}

export default function ChatWorkspace() {
  const [mode, setMode] = useState<Mode>("setup");
  const [prompt, setPrompt] = useState("");
  const [, setProfile] = useState<BusinessProfile>(() => businessProfileSchema.parse({}));
  const [builderMessages, setBuilderMessages] = useState<ChatMessage[]>([]);
  const [testMessages, setTestMessages] = useState<ChatMessage[]>([]);
  const [streamingId, setStreamingId] = useState<string | null>(null);
  const [freshPromptCardId, setFreshPromptCardId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
    isAtBottomRef.current = dist < 80;
  };
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [correction, setCorrection] = useState<CorrectionState | null>(null);
  const [promptDrawerOpen, setPromptDrawerOpen] = useState(false);
  const [extraDataOpen, setExtraDataOpen] = useState(false);
  const [isHydrated, setIsHydrated] = useState(false);
  const [inputDisabled, setInputDisabled] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const extraDataBtnRef = useRef<HTMLButtonElement>(null);

  // ── Голосовой ввод (STT) ────────────────────────────────────────────────
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  async function toggleRecording() {
    if (recording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      toast.error("Браузер не поддерживает запись голоса");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      audioChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(audioChunksRef.current, { type: recorder.mimeType || "audio/webm" });
        void transcribeBlob(blob, recorder.mimeType || "audio/webm");
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      toast.error("Нет доступа к микрофону");
    }
  }

  async function transcribeBlob(blob: Blob, mimeType: string) {
    setRecording(false);
    if (blob.size === 0) return;
    setTranscribing(true);
    try {
      const buf = await blob.arrayBuffer();
      let binary = "";
      const bytes = new Uint8Array(buf);
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
      const audioBase64 = btoa(binary);
      const res = await apiJson<{ ok: boolean; text?: string; error?: string }>("/transcribe", {
        method: "POST",
        body: JSON.stringify({ audioBase64, mimeType, language: "ru" })
      });
      if (res.ok && res.text) {
        setInput((prev) => (prev ? `${prev} ${res.text}` : res.text ?? ""));
      } else {
        toast.error(res.error ?? "Не удалось распознать речь");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка распознавания");
    } finally {
      setTranscribing(false);
    }
  }

  // ── Триггеры регистрации гостя в тестовом чате ──────────────────────────
  // Срабатывают ТОЛЬКО для неавторизованного пользователя и взаимоисключающи:
  // первый сработавший блокирует остальные в этой сессии.
  const authStatus = useAuthStatus();
  const isAuth = authStatus?.ok === true;
  // triggerFired — через ref: колбэк setTimeout (Trigger 2) должен читать
  // актуальное значение, а не захваченное на момент создания таймера.
  const triggerFiredRef = useRef(false);
  const correctionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const userMessageCountRef = useRef(0);
  // Счётчик успешных правок из теста — Trigger 2 срабатывает только после 3-й.
  const testCorrectionCountRef = useRef(0);
  // Непропускаемая подсказка у кнопки «Подключить WhatsApp»: показывается сразу
  // при срабатывании триггера. Затемняет вкладку теста и указывает на кнопку в
  // шапке, блокируя всё, кроме перехода к подключению.
  const [stickyHint, setStickyHint] = useState<{ title: string; description: string } | null>(null);

  function markTriggerFired() {
    triggerFiredRef.current = true;
  }

  // Показ непропускаемой подсказки у кнопки «Подключить WhatsApp». Блокируем
  // ввод и просим шапку скрыть свой мягкий coachmark, чтобы подсказки не
  // накладывались друг на друга.
  function showConnectHint(opts: { title: string; description: string }) {
    setInputDisabled(true);
    setStickyHint(opts);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new Event("jazu:connectHintShown"));
    }
  }

  async function refreshPrompt() {
    try {
      const data = await apiJson<PromptResponse>("/agent/prompt");
      setPrompt(data.prompt);
      setProfile(businessProfileSchema.parse(data.businessProfile));
    } catch { /* non-critical */ }
  }

  async function refreshHistories() {
    try {
      const [builder, test] = await Promise.all([
        apiJson<ChatMessage[]>("/agent/history"),
        apiJson<ChatMessage[]>("/test-chat/history")
      ]);
      setBuilderMessages(normalize(builder));
      setTestMessages(normalize(test));
    } catch { /* non-critical */ }
  }

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        await apiJson("/session", { method: "POST" });
        await Promise.all([refreshPrompt(), refreshHistories()]);
      } finally {
        if (mounted) setIsHydrated(true);
      }
    })().catch(() => { if (mounted) setIsHydrated(true); });

    const handler = () => setMode("test");
    window.addEventListener("jazu:switchToTest", handler);
    return () => {
      mounted = false;
      window.removeEventListener("jazu:switchToTest", handler);
    };
  }, []);

  useEffect(() => {
    if (isAtBottomRef.current) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [builderMessages, testMessages, streamingId]);

  async function submitMessage() {
    const text = input.trim();
    if (!text || busy) return;

    setBusy(true);
    const sid = crypto.randomUUID();
    setStreamingId(sid);

    if (mode === "setup") {
      const opt: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, parts: [], createdAt: new Date().toISOString() };
      const placeholder: ChatMessage = { id: sid, role: "assistant", content: "", parts: [], createdAt: new Date().toISOString() };
      setBuilderMessages((prev) => [...prev, opt, placeholder]);
      setInput("");

      try {
        const turn = await apiSse<TurnResponse>("/agent/chat", { message: text }, (token) => {
          setBuilderMessages((prev) =>
            prev.map((m) => m.id === sid ? { ...m, content: m.content + token } : m)
          );
        });
        setBuilderMessages((prev) =>
          prev.map((m) => {
            if (m.id !== sid) return m;
            const final = turn.assistantText || m.content;
            const fallbackParts: AssistantPart[] = [
              { type: "text", text: final },
              ...(turn.actionButton ? [{ type: "action_button" as const, action_button: turn.actionButton }] : [])
            ];
            const parts = turn.assistantParts && turn.assistantParts.length > 0
              ? turn.assistantParts
              : fallbackParts;
            return {
              ...m,
              content: final,
              parts: parts
            };
          })
        );
        if (turn.promptCard || (turn.assistantParts && turn.assistantParts.some((p) => p.type === "prompt_card"))) {
          setFreshPromptCardId(sid);
        }
        if (turn.promptDraft) {
          setPrompt(turn.promptDraft);
        }
        await refreshPrompt();
        notifyPromptProgress();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Ошибка при отправке");
        setBuilderMessages((prev) => prev.filter((m) => m.id !== sid));
      } finally {
        setBusy(false);
        setStreamingId(null);
      }
      return;
    }

    const opt: ChatMessage = { id: crypto.randomUUID(), role: "user", content: text, parts: [], createdAt: new Date().toISOString() };
    const placeholder: ChatMessage = { id: sid, role: "assistant", content: "", parts: [], createdAt: new Date().toISOString() };
    setTestMessages((prev) => [...prev, opt, placeholder]);
    setInput("");
    // Считаем сообщения пользователя для Trigger 3 (лимит).
    userMessageCountRef.current += 1;

    try {
      const turn = await apiSse<TurnResponse>("/test-chat/chat", { message: text }, (token) => {
        setTestMessages((prev) =>
          prev.map((m) => m.id === sid ? { ...m, content: m.content + token } : m)
        );
      });
      setTestMessages((prev) =>
        prev.map((m) => {
          if (m.id !== sid) return m;
          const final = turn.reply || turn.assistantText || m.content;
          return {
            ...m,
            content: final,
            parts: [
              { type: "text", text: final },
              ...(turn.actionButton ? [{ type: "action_button", action_button: turn.actionButton }] : [])
            ] as ChatMessage["parts"]
          };
        })
      );
      maybeFireChatTriggers(turn);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Ошибка");
      setTestMessages((prev) => prev.filter((m) => m.id !== sid));
    } finally {
      setBusy(false);
      setStreamingId(null);
    }
  }

  // Триггеры на ответ из /test-chat/chat. Приоритет: 1 (hot_lead) > 3 (лимит).
  // Оба могут «хотеть» сработать на одном ответе — порядок строгий.
  function maybeFireChatTriggers(turn: TurnResponse) {
    if (isAuth || triggerFiredRef.current) return;

    // Trigger 1 — горячий лид (наивысший приоритет).
    if (turn.shouldHandoff && turn.handoffType === "hot_lead") {
      markTriggerFired();
      if (correctionTimerRef.current) clearTimeout(correctionTimerRef.current);
      showConnectHint({
        title: "Ваш бот только что закрыл тестового лида! ⚡️",
        description:
          "Готовы получать такие же заявки от реальных клиентов? Привяжите WhatsApp в 1 клик, чтобы сохранить бота и подключить его к реальным клиентам."
      });
      return;
    }

    // Trigger 3 — лимит сообщений.
    if (userMessageCountRef.current >= 10) {
      markTriggerFired();
      if (correctionTimerRef.current) clearTimeout(correctionTimerRef.current);
      showConnectHint({
        title: "Ваш ИИ-продавец отлично держит удар! 🥊",
        description:
          "Система полностью готова к бою. Привяжите WhatsApp в 1 клик, чтобы забрать этого бота себе и подключить к реальным клиентам."
      });
    }
  }

  async function submitCorrection(correctionText: string) {
    if (!correction) return;
    setBusy(true);
    const wasInTest = mode === "test";
    try {
      const endpoint = wasInTest ? "/test-chat/correct" : "/agent/correct";
      await apiJson<{
        ok: boolean;
        assistantText?: string;
        changeSummary?: string;
        correctionType?: string;
        sectionEdited?: string;
        regenerated?: { id: string; content: string } | null;
        staleMessageId?: string | null;
      }>(endpoint, {
        method: "POST",
        body: JSON.stringify({ messageId: correction.messageId, correction: correctionText })
      });
      setCorrection(null);
      await Promise.all([refreshPrompt(), refreshHistories()]);
      notifyPromptProgress();
      // Trigger 2 — после 3-й успешной правки из теста. Откладываем подсказку
      // на 5с, чтобы юзер увидел результат правки. Читаем актуальный ref в
      // колбэке.
      if (wasInTest) testCorrectionCountRef.current += 1;
      const willFireTrigger2 =
        wasInTest &&
        !isAuth &&
        !triggerFiredRef.current &&
        testCorrectionCountRef.current >= 3;
      if (willFireTrigger2) {
        correctionTimerRef.current = setTimeout(() => {
          if (triggerFiredRef.current) return;
          markTriggerFired();
          showConnectHint({
            title: "Идеально! Бот усвоил ваши правила.",
            description:
              "Сохраните прогресс, чтобы настройки не потерялись, привяжите WhatsApp и подключите бота к реальным клиентам."
          });
        }, 5000);
      }
      // После правки из теста — переключаем юзера в чат Настройки, чтобы он
      // увидел зелёную карточку «Промпт обновлён» в основном месте правды.
      // Но если сейчас сработает триггер регистрации — остаёмся в тесте, чтобы
      // затемнение и подсказка показались именно на вкладке теста.
      if (wasInTest && !willFireTrigger2) {
        setMode("setup");
        const builderList = await apiJson<ChatMessage[]>("/agent/history");
        const lastWithCard = [...builderList].reverse().find((m) => getPromptCard(m.parts ?? []));
        if (lastWithCard) {
          setFreshPromptCardId(lastWithCard.id);
        }
      }
      isAtBottomRef.current = true;
      requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Не удалось поправить");
    } finally {
      setBusy(false);
    }
  }

  async function resetTest() {
    try {
      await apiJson("/test-chat/reset", { method: "POST" });
      setTestMessages([]);
      toast("Диалог сброшен");
    } catch { /* non-critical */ }
  }

  const messages = mode === "setup" ? builderMessages : testMessages;
  const isTest = mode === "test";

  if (!isHydrated) {
    return (
      <div className="grid min-h-[60vh] place-items-center">
        <div className="rounded-xl border border-border bg-card px-6 py-5 text-sm text-muted-foreground">
          Загружаем рабочее пространство…
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        "relative flex h-full min-h-0 flex-1 flex-col overflow-hidden transition-colors",
        isTest ? "bg-test-canvas" : "bg-card"
      )}
    >
      {/* Header */}
      <div
        className={cn(
          "flex items-center justify-between border-b px-4 py-3",
          isTest ? "border-black/5 bg-test-canvas" : "border-border bg-card"
        )}
      >
        <div className="flex min-w-0 items-center gap-2">
          <h1 className="truncate text-sm font-semibold text-foreground">
            {isTest ? "Диалог как клиент" : "Настройка бота"}
          </h1>
          <span className="hidden truncate text-xs text-muted-foreground sm:inline">
            {isTest ? "WhatsApp-режим" : "AI соберёт промпт по диалогу"}
          </span>
        </div>

        {isTest && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => setPromptDrawerOpen(true)}
              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-black/5 hover:text-foreground"
              title="Посмотреть текущий промпт"
            >
              <FileText className="h-3.5 w-3.5" />
              Промпт
            </button>
            <button
              type="button"
              onClick={() => void resetTest()}
              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-black/5 hover:text-foreground"
              title="Новый диалог"
            >
              <RotateCcw className="h-3.5 w-3.5" />
              Сбросить
            </button>
          </div>
        )}

        {!isTest && isAuth && (
          <div className="flex items-center gap-1">
            <button
              ref={extraDataBtnRef}
              type="button"
              onClick={() => setExtraDataOpen(true)}
              className="flex items-center gap-1 rounded-full bg-secondary px-2.5 py-1 text-xs font-medium text-foreground transition hover:bg-secondary/70"
              title="Добавить данные о бизнесе: ссылки, прайс, адреса, часы работы"
            >
              <FileText className="h-3.5 w-3.5" />
              Добавить данные о бизнесе
            </button>
          </div>
        )}
      </div>

      {/* Messages */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-hide flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto overscroll-y-contain px-3 pt-4 pb-44 sm:px-4 sm:pb-40"
      >
        <div className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-4">
        {messages.length === 0 ? (
          <div className="flex flex-1 items-center justify-center">
            <p className="max-w-md text-center text-sm text-muted-foreground">
              {mode === "setup"
                ? "Опишите бизнес одним сообщением, AI соберёт промпт и предложит уточнения."
                : "Напишите как ваш клиент, проверьте, как менеджер ответит."}
            </p>
          </div>
        ) : (
          messages.map((msg) => (
            <MessageRow
              key={msg.id}
              message={msg}
              mode={mode}
              isStreaming={msg.id === streamingId}
              animatePromptCard={msg.id === freshPromptCardId}
              {...(mode === "test" && msg.role === "assistant"
                ? { onCorrect: (m) => setCorrection({ messageId: m.id, text: m.content }) }
                : {})}
            />
          ))
        )}
          <div ref={bottomRef} />
        </div>
      </div>

      {/* Composer */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 px-2 pt-6 sm:px-3"
        style={{
          paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 12px)",
          background: `linear-gradient(to top, hsl(var(--${isTest ? "test-canvas" : "card"})) 0%, hsl(var(--${isTest ? "test-canvas" : "card"}) / 0.92) 60%, hsl(var(--${isTest ? "test-canvas" : "card"}) / 0) 100%)`
        }}
      >
        <div className="pointer-events-auto mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card shadow-sm">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submitMessage();
              }
            }}
            rows={1}
            disabled={busy || inputDisabled}
            placeholder={
              recording
                ? "Идёт запись… нажмите микрофон, чтобы остановить"
                : transcribing
                ? "Распознаём речь…"
                : mode === "setup"
                ? "Опишите бизнес или поправьте бота…"
                : "Напишите от лица клиента…"
            }
            className={cn(
              "block w-full resize-none bg-transparent px-4 pt-3 pb-1 text-[15px] leading-6 text-foreground outline-none placeholder:text-muted-foreground",
              "disabled:opacity-60"
            )}
            style={{ maxHeight: "180px" }}
          />

          <div className="flex items-center justify-between gap-2 px-2 pb-2">
            <div className="flex items-center gap-1">
              <ComposerTab
                active={mode === "setup"}
                onClick={() => setMode("setup")}
                icon={<Pencil className="h-3.5 w-3.5" />}
                label="Настройка"
                tone="default"
              />
              <ComposerTab
                active={mode === "test"}
                onClick={() => setMode("test")}
                icon={<Play className="h-3.5 w-3.5" />}
                label="Тест"
                tone="whatsapp"
              />
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => void toggleRecording()}
                disabled={busy || inputDisabled || transcribing}
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
                  recording
                    ? "animate-pulse bg-red-500 text-white"
                    : "bg-secondary text-foreground hover:bg-secondary/70"
                )}
                title={recording ? "Остановить запись" : "Голосовой ввод"}
                aria-label="Голосовой ввод"
              >
                <Mic className="h-5 w-5" />
              </button>
              <button
                type="button"
                onClick={() => void submitMessage()}
                disabled={busy || inputDisabled || transcribing || !input.trim()}
                aria-label="Отправить"
                className={cn(
                  "flex h-10 w-10 items-center justify-center rounded-full text-white transition-colors",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  isTest
                    ? "bg-[#25D366] hover:bg-[#1ebe5c]"
                    : "bg-foreground hover:bg-foreground/90"
                )}
              >
                <Send className="h-4 w-4 -translate-x-px" />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Correction dialog */}
      <Dialog open={Boolean(correction)} onOpenChange={(open) => { if (!open) setCorrection(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Поправить ответ бота</DialogTitle>
            <DialogDescription>
              Объясните, как бот должен отвечать в этом случае, промпт обновится автоматически.
            </DialogDescription>
          </DialogHeader>

          {correction && (
            <div className="rounded-xl bg-secondary px-4 py-3 text-sm leading-6 text-muted-foreground">
              {correction.text}
            </div>
          )}

          <div className="flex flex-wrap gap-1.5">
            {[
              "Здоровайся первым",
              "Делай ответы короче",
              "Сначала спрашивай имя",
              "Не называй цены",
              "Передай человеку если жалоба"
            ].map((chip) => (
              <button
                key={chip}
                type="button"
                onClick={() => {
                  const el = document.getElementById("correction-input") as HTMLTextAreaElement | null;
                  if (el) {
                    el.value = el.value ? `${el.value}\n${chip}` : chip;
                    el.focus();
                  }
                }}
                className="rounded-full border border-border bg-secondary/50 px-2.5 py-1 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              >
                + {chip}
              </button>
            ))}
          </div>

          <textarea
            id="correction-input"
            rows={4}
            className={cn(
              "mt-1 w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm outline-none transition placeholder:text-muted-foreground",
              "focus:border-foreground focus:ring-1 focus:ring-foreground/10"
            )}
            placeholder="Например: сначала спроси имя и тип запроса, потом передай администратору."
            defaultValue=""
          />

          <div className="flex justify-end gap-2">
            <Button
              variant="outline"
              onClick={() => setCorrection(null)}
            >
              Отмена
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const el = document.getElementById("correction-input") as HTMLTextAreaElement | null;
                void submitCorrection(el?.value || "");
              }}
            >
              {busy ? "Отправляю…" : "Отправить правку"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      {/* Доп-данные о бизнесе (структурированный ввод) */}
      <ExtraDataDialog
        open={extraDataOpen}
        onClose={() => setExtraDataOpen(false)}
        onSaved={() => void refreshPrompt()}
      />

      {/* Непропускаемая подсказка, указывающая на кнопку «Подключить WhatsApp»
          в шапке. Оверлей затемняет вкладку теста (z-40), кнопка в шапке выше
          оверлея и остаётся кликабельной. Стрелка карточки смотрит вверх, на
          кнопку. */}
      {stickyHint && (
        <div className="absolute inset-0 z-40">
          <div className="absolute inset-0 bg-foreground/40 backdrop-blur-[1px]" aria-hidden />
          <div className="absolute right-3 top-2 z-50 w-[min(20rem,calc(100vw-1.5rem))] rounded-2xl border border-[#25D366]/30 bg-card p-4 shadow-2xl">
            <div className="absolute -top-2 right-8 h-4 w-4 rotate-45 border-l border-t border-[#25D366]/30 bg-card" aria-hidden />
            <p className="text-sm font-semibold text-foreground">{stickyHint.title}</p>
            <p className="mt-1.5 text-xs leading-5 text-muted-foreground">{stickyHint.description}</p>
            <Link
              href="/whatsapp"
              className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-full bg-[#25D366] px-3 py-2 text-xs font-semibold text-white transition hover:bg-[#1ebe5c]"
            >
              <Smartphone className="h-3.5 w-3.5" />
              Подключить WhatsApp
            </Link>
          </div>
        </div>
      )}

      {/* Prompt drawer */}
      {promptDrawerOpen && (
        <div className="absolute inset-0 z-40 flex">
          <div
            className="flex-1 bg-foreground/30 backdrop-blur-sm"
            onClick={() => setPromptDrawerOpen(false)}
            aria-hidden
          />
          <div className="flex w-full max-w-xl flex-col border-l border-border bg-card shadow-2xl">
            <div className="flex items-center justify-between border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-foreground">Текущий промпт бота</h2>
                <p className="text-xs text-muted-foreground">Этим текстом руководствуется бот при ответе клиенту</p>
              </div>
              <button
                type="button"
                onClick={() => setPromptDrawerOpen(false)}
                className="rounded-full px-2 py-1 text-xs text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                aria-label="Закрыть"
              >
                ✕
              </button>
            </div>
            <div className="scrollbar-hide flex-1 overflow-y-auto px-4 py-4">
              {prompt && prompt.trim().length > 0 ? (
                <pre className="scrollbar-hide whitespace-pre-wrap break-words rounded-md bg-secondary px-3 py-3 font-mono text-[12px] leading-5 text-foreground">
                  {prompt}
                </pre>
              ) : (
                <div className="rounded-md border border-dashed border-border bg-secondary/40 px-4 py-8 text-center text-sm text-muted-foreground">
                  Промпт ещё не собран. Опишите бизнес в режиме «Настройка», он появится здесь.
                </div>
              )}
            </div>
            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <span className="text-xs text-muted-foreground">
                {prompt ? `${prompt.length} символов` : "пусто"}
              </span>
              <button
                type="button"
                onClick={() => {
                  if (prompt) {
                    void navigator.clipboard?.writeText(prompt).then(() => toast.success("Скопировано"));
                  }
                }}
                className="rounded-full bg-foreground px-3 py-1 text-xs font-medium text-background transition hover:opacity-90 disabled:opacity-40"
                disabled={!prompt}
              >
                Скопировать
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function ComposerTab({
  active,
  onClick,
  icon,
  label,
  tone = "default"
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  tone?: "default" | "whatsapp";
}) {
  const activeClass =
    tone === "whatsapp" ? "bg-[#25D366] text-white" : "bg-foreground text-background";
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium transition",
        active ? activeClass : "text-muted-foreground hover:bg-secondary hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  );
}
