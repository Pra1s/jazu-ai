export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  // h-full, не h-screen: на мобильном вьюпорте над main висит sticky-хедер 56px,
  // и h-screen внутри main = 100vh переполняет родителя, из-за чего композер
  // чата уходит за нижний край.
  return (
    <div className="flex h-full min-h-0 w-full flex-col">
      {children}
    </div>
  );
}
