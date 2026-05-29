import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Toaster } from "sonner";
import "./globals.css";
import AppShell from "@/components/app-shell";
import PhoneRequiredGuard from "@/components/phone-required-guard";
import { PostHogIdentify } from "@/components/posthog-identify";

const inter = Inter({
  subsets: ["latin", "cyrillic"],
  variable: "--font-inter",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Jazu AI",
  description: "AI-менеджер для WhatsApp — настройте бота за пять минут",
  icons: {
    icon: "/icon.svg"
  }
};

export default function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru" className={inter.variable}>
      <body
        className="h-dvh overflow-hidden bg-background text-foreground"
        style={{ fontFamily: "var(--font-inter), system-ui, sans-serif" }}
      >
        <PostHogIdentify />
        <AppShell>
          <PhoneRequiredGuard>{children}</PhoneRequiredGuard>
        </AppShell>
        <Toaster position="bottom-right" richColors />
      </body>
    </html>
  );
}
