import { type ReactNode } from "react";
import { AlertCircle, CheckCircle2, Info } from "lucide-react";
import { cn } from "@/lib/cn";

type AlertVariant = "error" | "success" | "info";

const VARIANTS: Record<
  AlertVariant,
  { container: string; icon: ReactNode }
> = {
  error: {
    container: "border-red-200 bg-red-50 text-red-700",
    icon: <AlertCircle className="h-4 w-4 shrink-0 text-red-500" aria-hidden="true" />
  },
  success: {
    container: "border-emerald-200 bg-emerald-50 text-emerald-700",
    icon: <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-500" aria-hidden="true" />
  },
  info: {
    container: "border-border bg-secondary text-foreground",
    icon: <Info className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
  }
};

export function FormAlert({
  children,
  variant = "error",
  className
}: {
  children: ReactNode;
  variant?: AlertVariant;
  className?: string;
}) {
  if (!children) return null;
  const { container, icon } = VARIANTS[variant];
  return (
    <div
      role={variant === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3.5 py-2.5 text-sm leading-5",
        container,
        className
      )}
    >
      {icon}
      <span className="min-w-0">{children}</span>
    </div>
  );
}
