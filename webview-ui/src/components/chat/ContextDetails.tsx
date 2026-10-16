import { useTranslation } from "react-i18next"
import { FoldVertical, HardDriveDownload, HardDriveUpload } from "lucide-react"
import prettyBytes from "pretty-bytes"

import type { HistoryItem, TodoItem } from "@alpha-code/types"

import { Button, StandardTooltip } from "@/components/ui"
import { formatLargeNumber } from "@/utils/format"

import { TaskActions } from "./TaskActions"
import { TodoListDisplay } from "./TodoListDisplay"
import type { TaskContextUsage } from "./useTaskContextUsage"

export interface ContextDetailsProps {
	currentTaskItem?: HistoryItem | null
	tokensIn: number
	tokensOut: number
	cacheWrites?: number
	cacheReads?: number
	totalCost: number
	aggregatedCost?: number
	hasSubtasks?: boolean
	costBreakdown?: string
	buttonsDisabled: boolean
	handleCondenseContext: (taskId: string) => void
	todos?: TodoItem[]
	usage?: TaskContextUsage
	showCondense?: boolean
}

/** The existing task metrics and advanced actions shared by both context presentations. */
export function ContextDetails({
	currentTaskItem,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	totalCost,
	aggregatedCost,
	hasSubtasks,
	costBreakdown,
	buttonsDisabled,
	handleCondenseContext,
	todos,
	usage,
	showCondense = false,
}: ContextDetailsProps) {
	const { t } = useTranslation()
	const safeTotalCost = Number.isFinite(totalCost) ? totalCost : 0
	const safeAggregatedCost = Number.isFinite(aggregatedCost) ? aggregatedCost! : safeTotalCost
	const costTooltip = hasSubtasks ? (
		<div>
			<div>{t("chat:costs.totalWithSubtasks", { cost: safeAggregatedCost.toFixed(2) })}</div>
			{costBreakdown && <div className="mt-1 text-xs">{costBreakdown}</div>}
		</div>
	) : (
		t("chat:costs.total", { cost: safeTotalCost.toFixed(2) })
	)

	return (
		<div className="min-w-0">
			<div className="flex min-h-7 items-center justify-between gap-2">
				<h3 className="text-xs font-semibold text-vscode-descriptionForeground">
					{t("chat:task.taskDetails")}
				</h3>
				{currentTaskItem && <TaskActions item={currentTaskItem} buttonsDisabled={buttonsDisabled} />}
			</div>
			{usage && (
				<div className="mt-2 flex items-center justify-between gap-2 text-xs text-vscode-descriptionForeground">
					<span>{t("chat:task.contextUsage")}</span>
					<span data-testid="context-usage-percent" className="tabular-nums">
						{usage.percentage}%
					</span>
				</div>
			)}
			<dl className="task-context-metrics mt-2 text-xs">
				<div className="task-context-metric min-w-0 rounded-md px-2.5 py-2">
					<dt className="mb-1 text-vscode-descriptionForeground">{t("chat:task.tokens")}</dt>
					<dd className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums text-sm font-medium text-vscode-foreground">
						<span className="inline-flex items-center gap-1.5">
							<span
								className="font-semibold text-[var(--vscode-charts-blue,var(--vscode-focusBorder))]"
								aria-hidden="true">
								↑
							</span>
							<span className="sr-only">{t("chat:task.inputTokens")}: </span>
							{formatLargeNumber(tokensIn || 0)}
						</span>
						<span className="inline-flex items-center gap-1.5">
							<span
								className="font-semibold text-[var(--vscode-charts-orange,var(--vscode-descriptionForeground))]"
								aria-hidden="true">
								↓
							</span>
							<span className="sr-only">{t("chat:task.outputTokens")}: </span>
							{formatLargeNumber(tokensOut || 0)}
						</span>
					</dd>
				</div>
				{((typeof cacheReads === "number" && cacheReads > 0) ||
					(typeof cacheWrites === "number" && cacheWrites > 0)) && (
					<div className="task-context-metric min-w-0 rounded-md px-2.5 py-2">
						<dt className="mb-1 text-vscode-descriptionForeground">{t("chat:task.cache")}</dt>
						<dd className="flex flex-wrap items-center gap-x-3 gap-y-1 tabular-nums text-sm font-medium text-vscode-foreground">
							{typeof cacheWrites === "number" && cacheWrites > 0 && (
								<span className="inline-flex items-center gap-1">
									<HardDriveDownload className="size-3" aria-hidden="true" />
									{formatLargeNumber(cacheWrites)}
								</span>
							)}
							{typeof cacheReads === "number" && cacheReads > 0 && (
								<span className="inline-flex items-center gap-1">
									<HardDriveUpload className="size-3" aria-hidden="true" />
									{formatLargeNumber(cacheReads)}
								</span>
							)}
						</dd>
					</div>
				)}
				{safeTotalCost > 0 && (
					<div className="task-context-metric min-w-0 rounded-md px-2.5 py-2">
						<dt className="mb-1 text-vscode-descriptionForeground">{t("chat:task.apiCost")}</dt>
						<dd className="tabular-nums text-sm font-medium text-vscode-foreground">
							<StandardTooltip content={costTooltip} side="top" sideOffset={8}>
								<span>
									${safeAggregatedCost.toFixed(2)}
									{hasSubtasks && (
										<span className="ml-1 text-xs" aria-label={t("chat:costs.includesSubtasks")}>
											*
										</span>
									)}
								</span>
							</StandardTooltip>
						</dd>
					</div>
				)}
				{!!currentTaskItem?.size && currentTaskItem.size > 0 && (
					<div className="task-context-metric min-w-0 rounded-md px-2.5 py-2">
						<dt className="mb-1 text-vscode-descriptionForeground">{t("chat:task.size")}</dt>
						<dd className="tabular-nums text-sm font-medium text-vscode-foreground">
							{prettyBytes(currentTaskItem.size)}
						</dd>
					</div>
				)}
			</dl>
			{showCondense && (
				<Button
					type="button"
					variant="secondary"
					size="sm"
					className="mt-3 w-full gap-1.5"
					disabled={buttonsDisabled || !currentTaskItem}
					onClick={() => currentTaskItem && handleCondenseContext(currentTaskItem.id)}>
					<FoldVertical className="size-3.5" aria-hidden="true" />
					{t("chat:task.condenseContext")}
				</Button>
			)}
			{todos && todos.length > 0 && (
				<div className="mt-2.5 border-t border-[var(--border-subtle)] pt-2">
					<TodoListDisplay todos={todos} />
				</div>
			)}
		</div>
	)
}
