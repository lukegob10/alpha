import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
	({ className, type, ...props }, ref) => {
		return (
			<input
				type={type}
				className={cn(
					"flex h-8 w-full rounded-lg border border-[var(--alpha-border-strong)] bg-vscode-input-background px-3 py-1 text-base text-vscode-input-foreground shadow-[inset_0_1px_1px_color-mix(in_srgb,var(--vscode-widget-shadow,#000)_18%,transparent)] outline-none transition-[border-color,box-shadow] file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-vscode-focusBorder focus-visible:ring-1 focus-visible:ring-vscode-focusBorder disabled:cursor-not-allowed disabled:opacity-50",
					className,
				)}
				ref={ref}
				{...props}
			/>
		)
	},
)
Input.displayName = "Input"

export { Input }
