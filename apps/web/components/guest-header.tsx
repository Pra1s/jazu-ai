"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Zap, X } from "lucide-react";
import { persistNext } from "@/lib/safe-next";

function WhatsAppIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
      <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
    </svg>
  );
}
import { apiJson } from "@/lib/api";

type ProgressResponse = {
  hasPrompt: boolean;
  correctionsCount: number;
  waConnected: boolean;
};


function Logo() {
  return (
    <Link href="/" className="flex items-center gap-2.5">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-foreground">
        <Zap className="h-4 w-4 text-background" />
      </div>
      <span className="text-sm font-semibold tracking-tight text-foreground">Jazu</span>
    </Link>
  );
}

export default function GuestHeader() {
  const pathname = usePathname();
  const router = useRouter();
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [notReadyOpen, setNotReadyOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const refreshProgress = useCallback(async () => {
    try {
      const data = await apiJson<ProgressResponse>("/agent/progress");
      setProgress(data);
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    void refreshProgress();
    const handler = () => void refreshProgress();
    window.addEventListener("jazu:promptProgress", handler);
    return () => window.removeEventListener("jazu:promptProgress", handler);
  }, [refreshProgress]);

  const isAuthPath = pathname.startsWith("/auth");
  const isWhatsappPath = pathname.startsWith("/whatsapp");
  const isLanding = pathname === "/";
  // На дашборде (не лендинг, не /auth, не /whatsapp) всегда показываем кнопку
  // «Подключить WhatsApp». На лендинге — «Войти».
  const showWaCta = !isLanding && !isAuthPath && !isWhatsappPath;
  const hasPrompt = !!progress?.hasPrompt;

  function handleConnectClick() {
    if (!hasPrompt) {
      setNotReadyOpen(true);
      return;
    }
    persistNext("/whatsapp");
    router.push("/auth?next=/whatsapp");
  }

  return (
    <>
    <header className="relative z-30 flex h-14 shrink-0 items-center justify-between gap-2 border-b border-border bg-background/95 px-3 backdrop-blur sm:px-6">
      <Logo />

      <div className="flex min-w-0 items-center gap-1.5 sm:gap-2">
        {showWaCta && (
          <>
            <button
              type="button"
              onClick={() => setHelpOpen(true)}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition hover:bg-secondary hover:text-foreground"
              title="Помощь"
              aria-label="Помощь"
            >
              <span className="text-sm font-semibold leading-none">?</span>
            </button>
            <button
              type="button"
              onClick={handleConnectClick}
              className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#25D366] px-3 py-2 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#1ebe5c] sm:gap-2 sm:px-4 sm:text-sm"
            >
              <WhatsAppIcon className="h-4 w-4 shrink-0" />
              Подключить WhatsApp
            </button>
          </>
        )}

        {!showWaCta && !isAuthPath && (
          <Link
            href="/auth"
            className="flex items-center gap-2 whitespace-nowrap rounded-lg border border-border bg-background px-3 py-2 text-xs font-medium text-foreground transition-colors hover:bg-secondary sm:px-4 sm:text-sm"
          >
            Войти
          </Link>
        )}
      </div>

    </header>

      {/* Модалка: бот ещё не настроен — вне <header>, чтобы fixed корректно перекрывал экран */}
      {notReadyOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 px-4"
          onClick={() => setNotReadyOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-2xl border border-border bg-card p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-foreground">
              Сначала доделайте бота
            </h2>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              Бот ещё не настроен. Вернитесь в «Настройку» и обучите его
              отвечать клиентам — потом подключите WhatsApp.
            </p>
            <button
              type="button"
              onClick={() => setNotReadyOpen(false)}
              className="mt-5 w-full rounded-full bg-foreground py-2.5 text-sm font-semibold text-background transition hover:opacity-90"
            >
              Понятно
            </button>
          </div>
        </div>
      )}
      {/* Модалка: помощь */}
      {helpOpen && (
        <div
          className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 sm:items-center"
          onClick={() => setHelpOpen(false)}
        >
          <div
            className="w-full max-w-sm rounded-t-2xl border border-border bg-card p-6 shadow-2xl sm:rounded-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between">
              <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#25D366]/10">
                <WhatsAppIcon className="h-5 w-5 text-[#25D366]" />
              </div>
              <button
                type="button"
                onClick={() => setHelpOpen(false)}
                className="rounded-full p-1 text-muted-foreground transition hover:bg-secondary hover:text-foreground"
                aria-label="Закрыть"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <h2 className="text-base font-semibold text-foreground">Нужна помощь?</h2>
            <p className="mt-2 text-sm leading-5 text-muted-foreground">
              Напишите нам в WhatsApp — поможем настроить бота, разобраться с
              подключением или решить любой вопрос.
            </p>
            <a
              href="https://wa.me/77000000000"
              target="_blank"
              rel="noopener noreferrer"
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-full bg-[#25D366] py-2.5 text-sm font-semibold text-white transition hover:bg-[#1ebe5c]"
              onClick={() => setHelpOpen(false)}
            >
              <WhatsAppIcon className="h-4 w-4" />
              Написать в WhatsApp
            </a>
          </div>
        </div>
      )}
    </>
  );
}
