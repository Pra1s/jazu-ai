export const API_BASE_URL = process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:3001/api";

function buildUrl(path: string) {
  if (path.startsWith("http://") || path.startsWith("https://")) {
    return path;
  }

  return `${API_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

export async function apiFetch(path: string, init?: RequestInit) {
  const hasBody = init?.body !== undefined && init?.body !== null && init?.body !== "";
  const headers = {
    ...(hasBody ? { "Content-Type": "application/json" } : {}),
    ...(init?.headers || {})
  };

  return fetch(buildUrl(path), {
    credentials: "include",
    headers,
    ...init
  });
}

export async function apiJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    // Бэкенд кладёт человекочитаемую причину в поле message (напр. ошибки
    // валидации 400) — показываем её юзеру вместо голого статуса.
    let message = `Request failed: ${response.status}`;
    try {
      const data = (await response.json()) as { message?: unknown };
      if (typeof data.message === "string" && data.message.trim()) {
        message = data.message;
      }
    } catch {
      // тело не JSON — оставляем статусное сообщение
    }
    throw new Error(message);
  }
  return (await response.json()) as T;
}

export async function apiSse<T>(
  path: string,
  body: unknown,
  onToken?: (token: string) => void
): Promise<T> {
  const response = await apiFetch(path, {
    method: "POST",
    body: JSON.stringify(body)
  });

  if (!response.ok || !response.body) {
    const text = await response.text();
    throw new Error(`SSE request failed: ${response.status} ${text}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastEvent: T | null = null;

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }

    buffer += decoder.decode(value, { stream: true });
    const chunks = buffer.split("\n\n");
    buffer = chunks.pop() || "";

    for (const chunk of chunks) {
      const lines = chunk.split("\n");
      let eventName = "message";
      let dataLine = "";

      for (const line of lines) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        }
        if (line.startsWith("data:")) {
          dataLine = line.slice(5).trim();
        }
      }

      if (eventName === "token" && onToken && dataLine) {
        try {
          const parsed = JSON.parse(dataLine) as { token?: string };
          if (parsed.token) {
            onToken(parsed.token);
          }
        } catch {
          // ignore
        }
      }

      if (eventName === "error" && dataLine) {
        try {
          const parsed = JSON.parse(dataLine) as { message?: string };
          throw new Error(parsed.message || "Stream error");
        } catch (err) {
          if (err instanceof Error) {
            throw err;
          }
          throw new Error("Stream error", { cause: err });
        }
      }

      if (eventName === "done" || eventName === "message") {
        try {
          lastEvent = JSON.parse(dataLine) as T;
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }

  if (lastEvent === null) {
    throw new Error("No SSE data received");
  }

  return lastEvent;
}
