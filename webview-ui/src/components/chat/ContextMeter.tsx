import { forwardRef, type ButtonHTMLAttributes } from "react"
import { useTranslation } from "react-i18next"

import { StandardTooltip } from "@/components/ui"
import { cn } from "@/lib/utils"
import { formatLargeNumber } from "@/utils/format"

import type { TaskContextUsage } from "./useTaskContextUsage"

export function ContextUsageTooltip({ usage }: { usage: TaskContextUsage }) {
	const { t } = useTranslation()
	return (
		<div className="space-y-1 text-xs">
			<div>
				{t("chat:tokenProgress.tokensUsed", {
					used: formatLargeNumber(usage.contextTokens),
					total: formatLargeNumber(usage.contextWindow),
				})}
			</div>
			{usage.reservedForOutput > 0 && (
				<div>
					{t("chat:tokenProgress.reservedForResponse", {
						amount: formatLargeNumber(usage.reservedForOutput),
					})}
				</div>
			)}
			<div>{t("chat:tokenProgress.availableSpace", { amount: formatLargeNumber(usage.availableSpace) })}</div>
		</div>
	)
}

interface ContextMeterProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	usage: TaskContextUsage
}

/** A compact, keyboard-focusable entry point to context details; usage stays in its tooltip. */
export const ContextMeter = forwardRef<HTMLButtonElement, ContextMeterProps>(function ContextMeter(
	{ usage, className, ...buttonProps },
	ref,
) {
	const { t } = useTranslation()
	return (
		<StandardTooltip content={<ContextUsageTooltip usage={usage} />} side="top" align="start" sideOffset={8}>
			<button
				ref={ref}
				type="button"
				aria-label={t("chat:task.expandContextDetails")}
				{...buttonProps}
				className={cn(
					"chat-context-meter block h-[9px] w-full cursor-pointer rounded-full border-0 bg-transparent px-0 py-[3px] text-inherit focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder",
					className,
				)}>
				<span
					role="progressbar"
					aria-label={t("chat:task.contextUsage")}
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={usage.percentage}
					className="block h-[3px] w-full overflow-hidden rounded-full bg-[color-mix(in_srgb,var(--vscode-foreground)_14%,transparent)]">
					<span
						className="block h-full rounded-full bg-[var(--vscode-progressBar-background,var(--vscode-focusBorder))] transition-[width] duration-300 motion-reduce:transition-none"
						style={{ width: `${usage.percentage}%` }}
					/>
				</span>
			</button>
		</StandardTooltip>
	)
})
