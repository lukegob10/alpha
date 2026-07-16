import * as React from "react"
import { Slot } from "@radix-ui/react-slot"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
	"inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-lg border border-transparent text-base font-medium shadow-none transition-[background-color,border-color,color,box-shadow,transform] duration-150 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-35 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 cursor-pointer active:translate-y-px",
	{
		variants: {
			variant: {
				primary:
					"bg-primary text-primary-foreground border-[color-mix(in_srgb,var(--vscode-button-background)_72%,var(--vscode-foreground))] shadow-[var(--alpha-shadow-sm)] hover:bg-vscode-button-hoverBackground",
				secondary:
					"bg-[var(--alpha-surface-raised)] text-secondary-foreground border-[var(--alpha-border-subtle)] hover:bg-accent hover:text-accent-foreground hover:border-[var(--alpha-border-strong)]",
				ghost: "hover:bg-accent hover:text-accent-foreground active:opacity-80",
				destructive: "bg-destructive text-destructive-foreground hover:bg-destructive/90",
				outline:
					"border border-[var(--alpha-border-strong)] text-vscode-foreground bg-transparent hover:bg-secondary hover:text-accent-foreground",
				link: "text-primary underline-offset-4 hover:underline",
				combobox:
					"border border-vscode-dropdown-border focus-visible:border-vscode-focusBorder bg-vscode-dropdown-background hover:bg-transparent text-vscode-dropdown-foreground font-normal",
			},
			size: {
				default: "h-8 px-3.5",
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
