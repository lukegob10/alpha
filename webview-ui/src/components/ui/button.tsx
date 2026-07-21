import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg text-base font-medium transition-[color,background-color,border-color,box-shadow,transform,opacity] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder disabled:pointer-events-none disabled:opacity-40 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer active:translate-y-px active:opacity-90",
	{
		variants: {
			variant: {
				primary:
					"bg-[var(--alpha-accent)] text-[var(--alpha-accent-contrast)] shadow-[var(--shadow-accent)] hover:bg-[var(--alpha-accent-hover)]",
				secondary:
					"border border-[var(--border-subtle)] bg-[var(--surface-raised)] text-secondary-foreground shadow-sm hover:border-[var(--border-accent)] hover:bg-[var(--alpha-accent-soft)]",
				ghost: "hover:bg-[var(--alpha-accent-soft)] hover:text-foreground",
				destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
				outline:
					"border border-[var(--border-subtle)] bg-transparent text-vscode-foreground hover:border-[var(--border-accent)] hover:bg-[var(--alpha-accent-soft)]",
				link: "text-primary underline-offset-4 hover:underline",
				combobox:
					"border border-[var(--border-subtle)] bg-[var(--surface-sunken)] text-vscode-dropdown-foreground font-normal hover:border-[var(--border-accent)] hover:bg-[var(--alpha-accent-soft)] focus-visible:border-vscode-focusBorder",
			},
			size: {
				default: "h-8 px-3",
				sm: "h-7 px-2.5 text-sm",
				lg: "h-9 px-4 text-lg",
				icon: "h-8 w-8",
			},
		},
		defaultVariants: {
			variant: "secondary",
			size: "default",
		},
	},
)

export interface ButtonProps
	extends React.ButtonHTMLAttributes<HTMLButtonElement>,
		VariantProps<typeof buttonVariants> {
	asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
	({ className, variant, size, asChild = false, ...props }, ref) => {
		const Comp = asChild ? Slot : "button"
		return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />
	},
)
Button.displayName = "Button"

export { Button, buttonVariants }
