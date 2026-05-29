import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageContainer } from "@/components/page-container";

/**
 * Блоки юридического документа. Текст хранится структурно (а не как сырой
 * HTML), чтобы аккуратно отрисовать типографику. Формулировки взяты дословно
 * из исходных документов.
 */
export type LegalBlock =
  | { type: "section"; n?: string; title: string }
  | { type: "paragraph"; n?: string; text: string }
  | { type: "list"; items: string[] };

export type LegalDocData = {
  title: string;
  updated: string;
  intro?: string[];
  blocks: LegalBlock[];
};

function Paragraph({ n, text }: { n?: string | undefined; text: string }) {
  return (
    <p className="mt-3 text-sm leading-7 text-foreground/90">
      {n && <span className="font-semibold text-foreground">{n} </span>}
      {text}
    </p>
  );
}

export default function LegalDoc({ doc }: { doc: LegalDocData }) {
  return (
    <PageContainer size="narrow">
      <Link
        href="/"
        className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="h-4 w-4" />
        На главную
      </Link>

      <article className="mt-5">
        <header className="border-b border-border pb-5">
          <h1 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">
            {doc.title}
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">{doc.updated}</p>
        </header>

        {doc.intro?.map((text, i) => (
          <p key={`intro-${i}`} className="mt-4 text-sm leading-7 text-foreground/90">
            {text}
          </p>
        ))}

        {doc.blocks.map((block, i) => {
          if (block.type === "section") {
            return (
              <h2
                key={i}
                className="mt-8 text-base font-semibold tracking-tight text-foreground"
              >
                {block.n && <span className="text-muted-foreground">{block.n}. </span>}
                {block.title}
              </h2>
            );
          }
          if (block.type === "list") {
            return (
              <ul key={i} className="mt-3 space-y-2 pl-1">
                {block.items.map((item, j) => (
                  <li key={j} className="flex gap-2.5 text-sm leading-7 text-foreground/90">
                    <span className="mt-2.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
                    <span>{item}</span>
                  </li>
                ))}
              </ul>
            );
          }
          return <Paragraph key={i} n={block.n} text={block.text} />;
        })}
      </article>
    </PageContainer>
  );
}
