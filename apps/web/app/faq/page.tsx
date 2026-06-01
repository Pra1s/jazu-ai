import FaqSection from "@/components/faq-section";
import { PageContainer } from "@/components/page-container";

export default function FaqPage() {
  return (
    <PageContainer>
      <div className="mb-8 sm:mb-10">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground sm:text-4xl">
          Частые вопросы
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Коротко о том, как работает Jazu: настройка, WhatsApp, лиды и оплата.
        </p>
      </div>
      <FaqSection />
    </PageContainer>
  );
}
