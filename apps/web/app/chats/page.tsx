import { BotToggle } from "@/components/bot-toggle";
import ChatsClient from "@/components/chats-client";
import { PageContainer } from "@/components/page-container";

export default function ChatsPage() {
  return (
    <PageContainer>
      <div className="mb-4 flex flex-col gap-3 sm:mb-6 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
            Диалоги
          </div>
          <h1 className="mt-1 text-2xl font-semibold text-foreground sm:text-3xl">
            Inbox реальных клиентов
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
            Подключите WhatsApp, переписки, лиды и ответы менеджера появятся здесь.
          </p>
        </div>
        <div className="sm:pt-1">
          <BotToggle />
        </div>
      </div>
      <ChatsClient />
    </PageContainer>
  );
}
