import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
	({ className, ...props }, ref) => {
		return (
			<textarea
				className={cn(
					"flex min-h-[72px] w-full rounded-xl px-3 py-2 text-base shadow-sm transition-[border-color,box-shadow,background-color] duration-150 placeholder:text-muted-foreground focus:outline-0 focus-visible:outline-none focus-visible:border-[var(--border-accent)] focus-visible:ring-1 focus-visible:ring-[var(--alpha-accent)] disabled:cursor-not-allowed disabled:opacity-50",
					"border border-[var(--border-subtle)]",
					"bg-[var(--surface-sunken)] focus-visible:bg-vscode-input-background",
					"text-vscode-input-foreground",
					className,
				)}
				ref={ref}
				{...props}
			/>
		)
	},
)
Textarea.displayName = "Textarea"

export { Textarea }
