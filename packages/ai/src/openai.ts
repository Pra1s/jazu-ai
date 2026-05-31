export type ChatMessage = {
  role: "system" | "user" | "assistant";
  content: string;
};

export type ChatCompletionOptions = {
  model?: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
};

export type LlmUsage = {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
};

export type StreamChunk = {
  type: "token" | "done";
  token?: string;
  fullText?: string;
  usage?: LlmUsage;
};

/**
 * Маппинг model → цена $ за 1M токенов (input, output).
 * Источник: https://openai.com/api/pricing (на 2026-05).
 * При появлении новых моделей просто добавляем в карту; неизвестная модель
 * учитывается с нулевой стоимостью (calls будут логироваться, но в costMicroUsd=0).
 */
const PRICING_PER_MILLION_TOKENS: Record<string, { input: number; output: number }> = {
  "gpt-4.1":         { input: 2.0,  output: 8.0  },
  "gpt-4.1-mini":    { input: 0.4,  output: 1.6  },
  "gpt-4.1-nano":    { input: 0.1,  output: 0.4  },
  "gpt-4o":          { input: 2.5,  output: 10.0 },
  "gpt-4o-mini":     { input: 0.15, output: 0.6  },
  "o3-mini":         { input: 1.1,  output: 4.4  }
};

/** Возвращает стоимость вызова в микро-долларах (USD * 1_000_000), целое. */
export function calcCostMicroUsd(model: string, usage: LlmUsage): number {
  const tier = PRICING_PER_MILLION_TOKENS[model] ?? PRICING_PER_MILLION_TOKENS[model.split(":")[0] ?? ""];
  if (!tier) return 0;
  const inUsd = (usage.promptTokens / 1_000_000) * tier.input;
  const outUsd = (usage.completionTokens / 1_000_000) * tier.output;
  return Math.round((inUsd + outUsd) * 1_000_000);
}

export async function* completeStream(
  options: ChatCompletionOptions,
  onChunk?: (chunk: StreamChunk) => void
): AsyncGenerator<StreamChunk> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    yield { type: "done", fullText: "" };
    return;
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: options.model || process.env.OPENAI_MODEL || "gpt-4.1",
      messages: [{ role: "system", content: options.system }, ...options.messages],
      temperature: options.temperature ?? 0.2,
      stream: true
    })
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(`OpenAI stream failed: ${response.status} ${errorText}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") {
        continue;
      }

      const dataLine = trimmed.startsWith("data: ") ? trimmed.slice(6) : trimmed;
      try {
        const parsed = JSON.parse(dataLine) as {
          choices?: Array<{ delta?: { content?: string | null } }>;
        };
        const token = parsed.choices?.[0]?.delta?.content;
        if (token) {
          fullText += token;
          const chunk: StreamChunk = { type: "token", token };
          onChunk?.(chunk);
          yield chunk;
        }
      } catch {
        // malformed SSE chunk — skip
      }
    }
  }

  const finalChunk: StreamChunk = { type: "done", fullText };
  onChunk?.(finalChunk);
  yield finalChunk;
}

export type CompletionJsonResult<T> = {
  result: T | null;
  usage: LlmUsage;
  model: string;
  latencyMs: number;
};

/**
 * Вызов OpenAI chat completion с response_format=json_object.
 *
 * Возвращает не только результат, но и usage (для биллинга/телеметрии).
 * Если usage не пришёл от API (старые модели) — выставляем нули.
 *
 * Старая сигнатура (`Promise<T | null>`) сохранена в виде wrapper'а
 * `completeJson`, чтобы не ломать существующие импорты в @jazu/ai/index.ts.
 */
export async function completeJsonWithUsage<T>(options: ChatCompletionOptions): Promise<CompletionJsonResult<T>> {
  const model = options.model || process.env.OPENAI_MODEL || "gpt-4.1";
  const startedAt = Date.now();
  const emptyUsage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return { result: null, usage: emptyUsage, model, latencyMs: Date.now() - startedAt };
  }

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: options.system }, ...options.messages],
      temperature: options.temperature ?? 0.2,
      response_format: { type: "json_object" }
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  };

  const usage: LlmUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    totalTokens: data.usage?.total_tokens ?? 0
  };

  const content = data.choices?.[0]?.message?.content;
  if (!content) {
    return { result: null, usage, model, latencyMs: Date.now() - startedAt };
  }

  let parsed: T | null;
  try {
    parsed = JSON.parse(content) as T;
  } catch {
    parsed = null;
  }
  return { result: parsed, usage, model, latencyMs: Date.now() - startedAt };
}

/** Backwards-compatible: только результат, без usage. */
export async function completeJson<T>(options: ChatCompletionOptions): Promise<T | null> {
  const { result } = await completeJsonWithUsage<T>(options);
  return result;
}

/**
 * Тонкая «инжекция телеметрии» для билдеров (buildBuilderTurn, buildRuntimeTurn,
 * applyPromptCorrection). @jazu/ai НЕ знает про БД — он лишь вызывает callback'и,
 * которые приходят сверху (из @jazu/wa-pipeline / apps/api / apps/jobs).
 *
 * checkBudget — если возвращает false, билдер пропускает вызов LLM, отдаёт
 * fallback-ответ и не сжигает токены. onCall — пишет в LlmCallLog (или Sentry,
 * или что угодно ещё). Все callback-и опциональны.
 */
export type LlmCallTelemetry = {
  route: string;
  userId?: string | null;
  agentId?: string | null;
  status: "ok" | "error" | "budget_blocked";
  model: string;
  usage: LlmUsage;
  latencyMs: number;
  errorCode?: string;
};

export type LlmTelemetryHooks = {
  /** true — продолжаем, false — пропускаем LLM-вызов и идём в fallback. */
  checkBudget?: () => Promise<boolean> | boolean;
  /** Лог finish'а. Не должен бросать наружу — мы поймаем. */
  onCall?: (record: LlmCallTelemetry) => Promise<void> | void;
  route: string;
  userId?: string | null;
  agentId?: string | null;
};

/**
 * Вызов JSON-completion с budget-check и автоматической записью телеметрии.
 * Возвращает { blocked: true } если budget превышен — caller сам решает,
 * что отдать пользователю в этом случае (обычно fallback).
 */
export async function runJsonCallWithTelemetry<T>(
  options: ChatCompletionOptions,
  telemetry?: LlmTelemetryHooks
): Promise<{ blocked: false; result: T | null; usage: LlmUsage; model: string } | { blocked: true }> {
  if (telemetry?.checkBudget) {
    const allowed = await telemetry.checkBudget();
    if (!allowed) {
      await safeOnCall(telemetry, {
        route: telemetry.route,
        userId: telemetry.userId ?? null,
        agentId: telemetry.agentId ?? null,
        status: "budget_blocked",
        model: options.model || process.env.OPENAI_MODEL || "gpt-4.1",
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0
      });
      return { blocked: true };
    }
  }

  try {
    const { result, usage, model, latencyMs } = await completeJsonWithUsage<T>(options);
    await safeOnCall(telemetry, {
      route: telemetry?.route ?? "unknown",
      userId: telemetry?.userId ?? null,
      agentId: telemetry?.agentId ?? null,
      status: "ok",
      model,
      usage,
      latencyMs
    });
    return { blocked: false, result, usage, model };
  } catch (err) {
    await safeOnCall(telemetry, {
      route: telemetry?.route ?? "unknown",
      userId: telemetry?.userId ?? null,
      agentId: telemetry?.agentId ?? null,
      status: "error",
      model: options.model || process.env.OPENAI_MODEL || "gpt-4.1",
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      latencyMs: 0,
      errorCode: err instanceof Error ? err.message.slice(0, 200) : "unknown"
    });
    throw err;
  }
}

/**
 * Транскрипция аудио через OpenAI Whisper (speech-to-text).
 * Принимает байты аудио + имя файла, возвращает распознанный текст.
 */
export async function transcribeAudio(
  audio: ArrayBuffer | Uint8Array,
  options: { filename?: string; mimeType?: string; language?: string } = {}
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return "";

  const filename = options.filename || "audio.webm";
  const mimeType = options.mimeType || "audio/webm";
  const blob = new Blob([audio as BlobPart], { type: mimeType });

  const form = new FormData();
  form.append("file", blob, filename);
  form.append("model", process.env.OPENAI_STT_MODEL || "whisper-1");
  if (options.language) form.append("language", options.language);

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI transcription failed: ${response.status} ${errorText}`);
  }

  const data = (await response.json()) as { text?: string };
  return (data.text ?? "").trim();
}

async function safeOnCall(telemetry: LlmTelemetryHooks | undefined, record: LlmCallTelemetry): Promise<void> {
  if (!telemetry?.onCall) return;
  try {
    await telemetry.onCall(record);
  } catch (err) {
    console.error("[llm-telemetry] onCall failed:", err instanceof Error ? err.message : err);
  }
}

export function sanitizeAssistantText(value: string): string {
  return value.trim().replace(/\n{3,}/g, "\n\n");
}
