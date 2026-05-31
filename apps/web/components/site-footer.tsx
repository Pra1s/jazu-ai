"use client";

import { Mail } from "lucide-react";

const SUPPORT_EMAIL = "hello@jazu.chat";

const LEGAL_LINKS = [
  { href: "/legal/oferta", label: "Публичный договор-оферта" },
  { href: "/legal/usloviya", label: "Условия использования" },
  { href: "/legal/politika", label: "Политика конфиденциальности" }
];

// Единый футер: легал-ссылки + email поддержки. Используется на лендинге и
// в кабинете (страница настройки).
export default function SiteFooter({ className = "" }: { className?: string }) {
  return (
    <footer className={`border-t border-border py-6 ${className}`}>
      <div className="flex flex-col items-center gap-3 text-center">
        <p className="text-xs text-muted-foreground">
          © {new Date().getFullYear()} Jazu · ТОО «FINTECH IT»
        </p>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {LEGAL_LINKS.map((link) => (
            <a
              key={link.href}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {link.label}
            </a>
          ))}
          <a
            href={`mailto:${SUPPORT_EMAIL}`}
            className="flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
          >
            <Mail className="h-3.5 w-3.5" />
            {SUPPORT_EMAIL}
          </a>
        </nav>
      </div>
    </footer>
  );
}
