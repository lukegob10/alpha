import { cn } from "@/lib/utils"

export const ToolUseBlock = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn(
			"overflow-hidden rounded-xl border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-2 cursor-pointer transition-colors hover:border-[var(--border-accent)] hover:bg-[var(--alpha-accent-soft)]",
			className,
		)}
		{...props}
	/>
)

export const ToolUseBlockHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
	<div
		className={cn("flex font-mono items-center select-none text-sm text-vscode-descriptionForeground", className)}
		{...props}
	/>
)

export const ToolUseBlockHeaderButton = ({ className, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
	<button
		type="button"
		className={cn(
			"flex w-full items-center select-none rounded-sm border-0 bg-transparent p-0 text-left font-mono text-sm text-vscode-descriptionForeground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder",
			className,
		)}
		{...props}
	/>
)
