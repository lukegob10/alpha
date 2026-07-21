import * as React from "react"

import { cn } from "@/lib/utils"

const Input = React.forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
	({ className, type, ...props }, ref) => {
		return (
			<input
				type={type}
				className={cn(
					"flex min-h-8 w-full rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] px-3 py-1.5 text-base text-vscode-input-foreground shadow-sm transition-[border-color,box-shadow,background-color] duration-150 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-[var(--border-accent)] focus-visible:bg-vscode-input-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-[var(--alpha-accent)] disabled:cursor-not-allowed disabled:opacity-50",
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
