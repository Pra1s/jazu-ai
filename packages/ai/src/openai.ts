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
  "o3-mini":         { input: 1.1,  output: 4.4  },
  // Gemini (OpenAI-совместимый эндпоинт). Цены ориентировочные — сверить по
  // https://ai.google.dev/gemini-api/docs/pricing перед продакшеном.
  "gemini-2.5-flash":      { input: 0.30, output: 2.50 },
  "gemini-2.5-flash-lite": { input: 0.10, output: 0.40 },
  "gemini-2.0-flash":      { input: 0.10, output: 0.40 },
  // Боевая модель текста (та же, что в прогонах). Цена на 2026-06.
  "gemini-3.1-flash-lite": { input: 0.25, output: 1.50 }
};

/**
 * ХУК РОТАЦИИ КЛЮЧЕЙ (под прод-ротатор разраба).
 *
 * По умолчанию ничего не меняется: берётся ОДИН ключ из env (как раньше).
 * Для прод-нагрузки на пуле из множества ключей разраб подключает СВОЙ провайдер
 * через setLlmKeyProvider(fn): функция вызывается перед каждым LLM-вызовом и
 * возвращает следующий ПРИГОДНЫЙ ключ. Учёт лимитов на ключ (RPD/RPM/TPM,
 * напр. 490 запросов/сутки, 15 rpm, 250k токенов/мин) — целиком на стороне
 * провайдера разраба; этот модуль про лимиты не знает, он только спрашивает ключ.
 *
 * Порядок выбора ключа (selectApiKey):
 *   1) внешний провайдер (если задан setLlmKeyProvider и вернул непустой ключ);
 *   2) пул LLM_API_KEYS из env (через запятую) по кругу — round-robin БЕЗ учёта
 *      лимитов, удобно для дев/смоука без полноценного ротатора;
 *   3) одиночный ключ LLM_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY (легаси-дефолт).
 *
 * ВАЖНО: внутренние ретраи на 429/5xx (fetchWithRetry) переиспользуют ТОТ ЖЕ ключ
 * в рамках одного вызова. Если провайдер должен менять ключ на каждую 429, выставьте
 * LLM_MAX_RETRIES=0 и обрабатывайте 429 на уровне ротатора (повторный вызов с новым
 * ключом). Whisper (transcribeAudio) этот хук НЕ использует — он всегда на OPENAI_API_KEY.
 */
export type LlmKeyProvider = () => string | undefined;
let externalKeyProvider: LlmKeyProvider | null = null;
export function setLlmKeyProvider(provider: LlmKeyProvider | null): void {
  externalKeyProvider = provider;
}

let keyRrPointer = 0;
function selectApiKey(): string | undefined {
  if (externalKeyProvider) {
    const k = externalKeyProvider();
    if (k) return k; // провайдер отдал ключ; если вернул пусто (все исчерпаны) — падаем ниже
  }
  const pool = (process.env.LLM_API_KEYS || "")
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  if (pool.length > 0) {
    const k = pool[keyRrPointer % pool.length];
    keyRrPointer = (keyRrPointer + 1) % pool.length;
    return k;
  }
  return process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY;
}

/**
 * Конфиг LLM-провайдера. По умолчанию — OpenAI (поведение как раньше, нулевой
 * риск). Чтобы переключить на Gemini, задать в .env:
 *   LLM_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
 *   LLM_API_KEY=<GEMINI_API_KEY>   (или пул LLM_API_KEYS / провайдер, см. выше)
 *   LLM_MODEL=gemini-2.5-flash     (или прежний OPENAI_MODEL)
 * Эндпоинт принимает тот же формат chat/completions (messages, temperature,
 * response_format=json_object, stream) и отдаёт choices[].delta/message + usage.
 */
function llmConfig(overrideModel?: string): { baseUrl: string; apiKey: string | undefined; model: string } {
  const baseUrl = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  const apiKey = selectApiKey();
  const model = overrideModel || process.env.LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4.1";
  return { baseUrl, apiKey, model };
}

/** Дефолтная модель для телеметрии/логов (без сетевого вызова). */
function defaultModel(overrideModel?: string): string {
  return overrideModel || process.env.LLM_MODEL || process.env.OPENAI_MODEL || "gpt-4.1";
}

// Временные сбои провайдера: rate limit (429), перегрузка/недоступность (5xx).
// На них делаем повтор с экспоненциальной паузой + джиттер. Постоянные ошибки
// (4xx кроме 429: неверный ключ, плохой запрос) НЕ ретраим — сразу отдаём.
const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);
const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
function backoffMs(attempt: number): number {
  return 2000 * 2 ** attempt + Math.floor(Math.random() * 500); // ~2с, 4с, 8с + джиттер
}

/**
 * fetch с повтором на временных ошибках провайдера (429/5xx). Уважает заголовок
 * Retry-After, если пришёл. maxRetries по умолчанию из LLM_MAX_RETRIES (или 3).
 */
async function fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
  const maxRetries = Number(process.env.LLM_MAX_RETRIES || 3);
  let attempt = 0;
  for (;;) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      if (attempt >= maxRetries) throw err; // сетевой сбой — исчерпали попытки
      await sleepMs(backoffMs(attempt));
      attempt += 1;
      continue;
    }
    if (!TRANSIENT_STATUSES.has(response.status) || attempt >= maxRetries) {
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoffMs(attempt);
    await sleepMs(waitMs);
    attempt += 1;
  }
}

/**
 * Толерантный парсинг JSON из ответа LLM. Модели (особенно Gemini free-tier)
 * иногда оборачивают JSON в ```json-фенсы или добавляют прозу до/после объекта.
 * Пробуем по порядку: как есть → снять markdown-фенсы → вырезать первый {…}.
 * Возвращает null, если всё мимо.
 */
function tryParseJson<T>(raw: string): T | null {
  const attempts: string[] = [raw];
  // снять ```json … ``` или ``` … ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) attempts.push(fenced[1]);
  // вырезать от первой { до последней }
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first !== -1 && last > first) attempts.push(raw.slice(first, last + 1));

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate.trim()) as T;
    } catch {
      // пробуем следующий вариант
    }
  }
  return null;
}

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
  const { baseUrl, apiKey, model } = llmConfig(options.model);
  if (!apiKey) {
    yield { type: "done", fullText: "" };
    return;
  }

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "system", content: options.system }, ...options.messages],
      temperature: options.temperature ?? 0.2,
      stream: true
    })
  });

  if (!response.ok || !response.body) {
    const errorText = await response.text();
    throw new Error(`LLM stream failed: ${response.status} ${errorText}`);
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
  const { baseUrl, apiKey, model } = llmConfig(options.model);
  const startedAt = Date.now();
  const emptyUsage: LlmUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

  if (!apiKey) {
    return { result: null, usage: emptyUsage, model, latencyMs: Date.now() - startedAt };
  }

  // Ретрай на НЕвалидный/пустой JSON. fetchWithRetry уже покрывает HTTP-сбои
  // (429/5xx), но «ответ пришёл, но это не JSON» раньше сразу давал result=null
  // → вызывающий код уходил в кривой fallback. На free-tier Gemini это частый
  // случай. Переспрашиваем до LLM_JSON_RETRIES раз (при temperature>0 повтор
  // обычно валиден). usage берём из последней попытки.
  const maxParseRetries = Number(process.env.LLM_JSON_RETRIES ?? 2);
  // Переприсваивается в каждой итерации до чтения; инициализатор был бы no-useless-assignment.
  let usage!: LlmUsage;

  for (let attempt = 0; ; attempt++) {
    const response = await fetchWithRetry(`${baseUrl}/chat/completions`, {
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
      throw new Error(`LLM request failed: ${response.status} ${errorText}`);
    }

    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string | null } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };

    usage = {
      promptTokens: data.usage?.prompt_tokens ?? 0,
      completionTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0
    };

    const content = data.choices?.[0]?.message?.content;
    const parsed = content ? tryParseJson<T>(content) : null;
    if (parsed !== null) {
      return { result: parsed, usage, model, latencyMs: Date.now() - startedAt };
    }
    if (attempt >= maxParseRetries) {
      return { result: null, usage, model, latencyMs: Date.now() - startedAt };
    }
    // пустой/битый JSON — короткая пауза и переспрос
    await sleepMs(backoffMs(attempt));
  }
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
        model: defaultModel(options.model),
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
