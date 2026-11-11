import type { ReactNode } from "react"
import { Info } from "lucide-react"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { cn } from "@/lib/utils"

import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { StandardTooltip } from "../ui/standard-tooltip"

type SettingsHelpProps = {
	label: string
	children: ReactNode
	className?: string
}

export function SettingsHelp({ label, children, className }: SettingsHelpProps) {
	const { t } = useAppTranslation()
	const helpLabel = t("settings:helpFor", { label })

	return (
		<Popover>
			<StandardTooltip
				content={helpLabel}
				maxWidth="min(300px, calc(100vw - 2rem))"
				className="whitespace-normal break-words">
				<PopoverTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						aria-label={helpLabel}
						data-settings-help-trigger="true"
						className={cn(
							"h-6 w-6 shrink-0 p-0 align-middle text-vscode-descriptionForeground",
							"[@media(pointer:coarse)]:min-h-[44px] [@media(pointer:coarse)]:min-w-[44px]",
							className,
						)}>
						<Info className="size-3.5" aria-hidden="true" />
					</Button>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				aria-label={helpLabel}
				className="max-h-[min(60vh,24rem)] w-80 max-w-[calc(100vw-2rem)] overflow-y-auto p-3 text-sm leading-relaxed break-words">
				<p className="m-0 mb-2 font-medium text-vscode-foreground">{label}</p>
				<div className="space-y-2 text-vscode-descriptionForeground">{children}</div>
			</PopoverContent>
		</Popover>
	)
}
