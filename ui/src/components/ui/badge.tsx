import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em] ring-1 ring-inset transition-colors",
  {
    variants: {
      variant: {
        default: "bg-primary/15 text-primary ring-primary/30",
        secondary: "bg-white/[0.06] text-secondary-foreground ring-white/10",
        destructive:
          "bg-pgm/15 text-pgm ring-pgm/40 shadow-[0_0_16px_-4px_hsl(var(--pgm)/0.8)]",
        outline: "text-muted-foreground ring-white/10",
        success:
          "bg-live/15 text-live ring-live/30 shadow-[0_0_14px_-5px_hsl(var(--live)/0.8)]",
        warning: "bg-busy/15 text-busy ring-busy/30",
        info: "bg-info/15 text-info ring-info/30",
      },
    },
    defaultVariants: { variant: "default" },
  }
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <div className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
