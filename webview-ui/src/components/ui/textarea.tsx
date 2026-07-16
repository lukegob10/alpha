import * as React from "react"

import { cn } from "@/lib/utils"

const Textarea = React.forwardRef<HTMLTextAreaElement, React.ComponentProps<"textarea">>(
	({ className, ...props }, ref) => {
		return (
			<textarea
				className={cn(
					"flex min-h-[60px] w-full rounded-lg px-3 py-2 text-base shadow-[inset_0_1px_1px_color-mix(in_srgb,var(--vscode-widget-shadow,#000)_18%,transparent)] placeholder:text-muted-foreground focus:outline-0 focus-visible:outline-none focus-visible:border-vscode-focusBorder focus-visible:ring-1 focus-visible:ring-vscode-focusBorder disabled:cursor-not-allowed disabled:opacity-50",
					"border border-[var(--alpha-border-strong)] focus-visible:border-vscode-focusBorder",
					"bg-vscode-input-background",
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
