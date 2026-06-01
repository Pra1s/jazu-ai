import WhatsappWizard from "@/components/whatsapp-wizard";
import { PageContainer } from "@/components/page-container";

export default function WhatsappPage() {
  return (
    <PageContainer size="narrow">
      <div className="mb-4 sm:mb-6">
        <div className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
          WhatsApp
        </div>
        <h1 className="mt-1 text-2xl font-semibold text-foreground sm:text-3xl">
          Подключение WhatsApp
        </h1>
        <p className="mt-2 max-w-2xl text-sm leading-6 text-muted-foreground">
          Привяжите номер по коду или QR, бот начнёт отвечать клиентам в вашем WhatsApp.
        </p>
      </div>
      <WhatsappWizard />
    </PageContainer>
  );
}
