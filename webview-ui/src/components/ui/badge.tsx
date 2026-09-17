import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const badgeVariants = cva(
	"inline-flex items-center rounded-full border border-transparent px-2 py-0.5 text-xs font-semibold transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
	{
		variants: {
			variant: {
				default:
					"border-[var(--border-subtle)] bg-[var(--surface-raised)] text-vscode-foreground hover:bg-vscode-list-hoverBackground",
				secondary:
					"border-[var(--border-subtle)] bg-[var(--surface-raised)] text-vscode-descriptionForeground hover:border-[var(--border-accent)]",
				destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/80",
				outline: "border-[var(--border-subtle)] text-muted-foreground",
			},
		},
		defaultVariants: {
			variant: "default",
		},
	},
)

export interface BadgeProps extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
	return <div className={cn(badgeVariants({ variant }), className)} {...props} />
}

export { Badge, badgeVariants }
