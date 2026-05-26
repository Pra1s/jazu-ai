import { type ReactNode } from "react";
import { cn } from "@/lib/cn";

export function PageContainer({
  children,
  className,
  size = "default"
}: {
  children: ReactNode;
  className?: string;
  size?: "default" | "narrow" | "wide";
}) {
  const max =
    size === "narrow" ? "max-w-3xl" : size === "wide" ? "max-w-7xl" : "max-w-6xl";

  return (
    <div className={cn("h-full w-full overflow-y-auto", className)}>
      <div
        className={cn(
          "mx-auto w-full px-4 py-6 pb-[max(env(safe-area-inset-bottom),1.5rem)] sm:px-6 lg:px-8 lg:pb-6",
          max
        )}
      >
        {children}
      </div>
    </div>
  );
}
