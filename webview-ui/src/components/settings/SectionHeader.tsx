import { HTMLAttributes } from "react"

import { cn } from "@/lib/utils"

type SectionHeaderProps = HTMLAttributes<HTMLDivElement> & {
	children: React.ReactNode
	description?: string
}

export const SectionHeader = ({ description, children, className, ...props }: SectionHeaderProps) => {
	return (
		<div
			className={cn(
				"sticky top-0 z-10 border-b border-[var(--alpha-border-subtle)] bg-[color-mix(in_srgb,var(--vscode-editor-background)_90%,transparent)] px-6 pt-6 pb-4 text-vscode-sideBar-foreground shadow-[0_1px_0_color-mix(in_srgb,var(--vscode-foreground)_4%,transparent)] backdrop-blur-md",
				className,
			)}
			{...props}>
			<h3 className="m-0 text-[1.3em] font-semibold tracking-[-0.01em] text-vscode-foreground">{children}</h3>
			{description && <p className="text-vscode-descriptionForeground text-sm mt-2 mb-0">{description}</p>}
		</div>
	)
}
