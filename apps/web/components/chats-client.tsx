"use client";

import { useEffect, useState } from "react";
import { ArrowLeft, MessageSquare, Smartphone } from "lucide-react";
import { apiJson } from "@/lib/api";
import { cn } from "@/lib/cn";
import { Button } from "@/components/ui/button";

type Conversation = {
  id: string;
  waChatId: string;
  customerName?: string | null;
  status: string;
  lastMessageAt?: string | null;
  lead?: { id: string; summary: string; status: string } | null;
  lastMessage?: { id: string; body: string; direction: "in" | "out"; createdAt: string } | null;
};

type Message = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt?: string;
};

function formatTime(iso?: string | null) {
  if (!iso) return "";
  const d = new Date(iso);
  return d.toLocaleTimeString("ru", { hour: "2-digit", minute: "2-digit" });
}

export default function ChatsClient() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [loading, setLoading] = useState(true);
  const [showThreadOnMobile, setShowThreadOnMobile] = useState(false);

  async function load() {
    const data = await apiJson<Conversation[]>("/chats");
    setConversations(data);
    setActiveId((prev) => prev || data[0]?.id || null);
    setLoading(false);
  }

  async function loadMessages(id: string) {
    const data = await apiJson<Message[]>(`/chats/${id}/messages`);
    setMessages(data);
  }

  useEffect(() => {
    load().catch(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (activeId) void loadMessages(activeId);
  }, [activeId]);

  function openConversation(id: string) {
    setActiveId(id);
    setShowThreadOnMobile(true);
  }

  if (loading) {
    return (
      <div className="flex min-h-60 items-center justify-center">
        <div className="rounded-xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground">
          Загружаем диалоги…
        </div>
      </div>
    );
  }

  if (conversations.length === 0) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-border bg-card p-8 text-center">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-secondary">
          <MessageSquare className="h-5 w-5 text-muted-foreground" />
        </div>
        <h2 className="text-base font-semibold">Нет диалогов</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          Подключите WhatsApp, реальные переписки появятся здесь автоматически.
        </p>
        <Button className="mt-5" asChild>
          <a href="/whatsapp">
            <Smartphone className="h-4 w-4" />
            Подключить WhatsApp
          </a>
        </Button>
      </div>
    );
  }

  const active = conversations.find((c) => c.id === activeId);

  return (
    <div
      className="grid gap-3 sm:gap-4 lg:grid-cols-[280px_1fr]"
      style={{ height: "calc(100dvh - 220px)", minHeight: "440px" }}
    >
      {/* Inbox */}
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card",
          showThreadOnMobile && "hidden lg:flex"
        )}
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="text-sm font-semibold">Inbox</h2>
        </div>
        <div className="flex-1 overflow-y-auto">
          {conversations.map((conv) => (
            <button
              key={conv.id}
              type="button"
              onClick={() => openConversation(conv.id)}
              className={cn(
                "flex w-full flex-col gap-0.5 border-b border-border px-4 py-3 text-left text-sm transition last:border-b-0",
                conv.id === activeId
                  ? "bg-foreground text-background"
                  : "hover:bg-secondary"
              )}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium">
                  {conv.customerName || conv.waChatId}
                </span>
                <span
                  className={cn(
                    "shrink-0 text-xs",
                    conv.id === activeId ? "text-background/60" : "text-muted-foreground"
                  )}
                >
                  {formatTime(conv.lastMessageAt)}
                </span>
              </div>
              <span
                className={cn(
                  "truncate text-xs",
                  conv.id === activeId ? "text-background/70" : "text-muted-foreground"
                )}
              >
                {conv.lastMessage?.body || conv.lead?.summary || "Нет сообщений"}
              </span>
              {conv.lead && (
                <span className="mt-1 inline-flex w-fit items-center rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-medium text-emerald-700">
                  Лид · {conv.lead.status}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Thread */}
      <div
        className={cn(
          "flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card",
          !showThreadOnMobile && "hidden lg:flex"
        )}
      >
        {active ? (
          <>
            <div className="flex items-center gap-2 border-b border-border px-3 py-3 sm:px-4">
              <button
                type="button"
                onClick={() => setShowThreadOnMobile(false)}
                className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-secondary hover:text-foreground lg:hidden"
                aria-label="К списку диалогов"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold">
                  {active.customerName || active.waChatId}
                </h2>
                <div className="truncate text-xs text-muted-foreground">{active.waChatId}</div>
              </div>
              {active.lead && (
                <span className="shrink-0 rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-medium text-emerald-700 sm:px-3 sm:text-xs">
                  Лид: {active.lead.status}
                </span>
              )}
            </div>
            <div className="flex-1 space-y-3 overflow-y-auto px-3 py-4 sm:px-4">
              {messages.length === 0 ? (
                <div className="flex min-h-32 items-center justify-center text-sm text-muted-foreground">
                  Нет сообщений
                </div>
              ) : (
                messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn("flex", msg.role === "user" ? "justify-start" : "justify-end")}
                  >
                    <div
                      className={cn(
                        "max-w-[85%] rounded-2xl px-3.5 py-2.5 text-sm leading-5 sm:max-w-[75%] sm:px-4",
                        msg.role === "user"
                          ? "border border-border bg-secondary text-foreground"
                          : "bg-foreground text-background"
                      )}
                    >
                      <p className="whitespace-pre-wrap break-words">{msg.content}</p>
                      {msg.createdAt && (
                        <p
                          className={cn(
                            "mt-1 text-[10px]",
                            msg.role === "user" ? "text-muted-foreground" : "text-background/50"
                          )}
                        >
                          {formatTime(msg.createdAt)}
                        </p>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
            Выберите диалог
          </div>
        )}
      </div>
    </div>
  );
}
