import { memo, useEffect, useLayoutEffect, useMemo, useState, useCallback, useRef } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react"
import { diffLines } from "diff"

import type { AlphaMessage } from "@alpha-code/types"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui"
import { cn } from "@/lib/utils"
import { openFileDiffs, type ReviewFile } from "@src/utils/openDiff"
import {
	fileChangesFromMessages,
	normalizedFileChangePath,
	type FileChangeEntry,
} from "./utils/fileChangesFromMessages"
import { projectTranscriptTurns } from "./utils/transcriptTurns"

interface FileChangesPanelProps {
	alphaMessages: AlphaMessage[] | undefined
	taskId?: string
	className?: string
	onExpandedChange?: () => void
}

const MAX_CACHED_NET_STATS = 128

function countChangedLines(originalContent: string, finalContent: string): { added: number; removed: number } {
	let added = 0
	let removed = 0
	for (const change of diffLines(originalContent, finalContent)) {
		if (change.added) added += change.count ?? 0
		if (change.removed) removed += change.count ?? 0
	}
	return { added, removed }
}

const FileChangesPanel = memo(({ alphaMessages, taskId, className, onExpandedChange }: FileChangesPanelProps) => {
	const { t } = useTranslation()
	const [panelExpanded, setPanelExpanded] = useState(false)
	const [showAllFiles, setShowAllFiles] = useState(false)
	const triggerRef = useRef<HTMLButtonElement>(null)
	const contentRef = useRef<HTMLDivElement>(null)
	const netStatsCacheRef = useRef(
		new Map<string, { originalContent: string; finalContent: string; stats: { added: number; removed: number } }>(),
	)

	// Reset disclosure state and derived stats when switching to a different task
	useEffect(() => {
		setPanelExpanded(false)
		setShowAllFiles(false)
		netStatsCacheRef.current.clear()
	}, [taskId])

	const turnCompleted = useMemo(
		() => projectTranscriptTurns(alphaMessages ?? []).some((turn) => turn.terminalStatus === "completed"),
		[alphaMessages],
	)
	useLayoutEffect(() => {
		if (!turnCompleted) return
		if (contentRef.current?.contains(document.activeElement)) triggerRef.current?.focus({ preventScroll: true })
		setPanelExpanded(false)
	}, [turnCompleted])

	const fileChanges = useMemo(() => fileChangesFromMessages(alphaMessages), [alphaMessages])

	// Group by path so we show one row per file (multiple edits to same file combined for display)
	const byPath = useMemo(() => {
		const map = new Map<string, FileChangeEntry[]>()
		for (const entry of fileChanges) {
			const key = normalizedFileChangePath(entry.path)
			const list = map.get(key) ?? []
			list.push(entry)
			map.set(key, list)
		}
		return map
	}, [fileChanges])

	const summariesByPath = useMemo(() => {
		const summaries = new Map<string, { added: number; removed: number }>()
		const netStatsCache = netStatsCacheRef.current
		for (const path of netStatsCache.keys()) {
			const entries = byPath.get(path)
			if (
				!entries ||
				entries[0].originalContent === undefined ||
				entries[entries.length - 1].finalContent === undefined
			) {
				netStatsCache.delete(path)
			}
		}
		for (const [path, entries] of byPath) {
			const originalContent = entries[0].originalContent
			const finalContent = entries[entries.length - 1].finalContent
			if (originalContent !== undefined && finalContent !== undefined) {
				const cached = netStatsCache.get(path)
				if (cached?.originalContent === originalContent && cached.finalContent === finalContent) {
					summaries.set(path, cached.stats)
				} else {
					const stats = countChangedLines(originalContent, finalContent)
					// Retain active paths: evicting during this scan makes every path miss above the cache limit.
					if (cached || netStatsCache.size < MAX_CACHED_NET_STATS) {
						netStatsCache.set(path, { originalContent, finalContent, stats })
					}
					summaries.set(path, stats)
				}
			} else {
				const stats = entries.reduce(
					(acc, entry) => ({
						added: acc.added + (entry.diffStats?.added ?? 0),
						removed: acc.removed + (entry.diffStats?.removed ?? 0),
					}),
					{ added: 0, removed: 0 },
				)
				summaries.set(path, stats)
			}
		}
		return summaries
	}, [byPath])

	const totalStats = useMemo(
		() =>
			Array.from(summariesByPath.values()).reduce(
				(acc, stats) => ({
					added: acc.added + stats.added,
					removed: acc.removed + stats.removed,
				}),
				{ added: 0, removed: 0 },
			),
		[summariesByPath],
	)

	const reviewFiles = useMemo<ReviewFile[]>(
		() =>
			Array.from(byPath, ([path, entries]) => ({
				path,
				diff: entries.map((entry) => entry.diff).join("\n\n"),
				originalContent: entries[0].originalContent,
				finalContent: entries[entries.length - 1].finalContent,
			})),
		[byPath],
	)

	const openDiff = useCallback(
		(files: ReviewFile[]) => {
			const fallbackTitle = t("chat:fileChangesInConversation.diffTitle")
			const title =
				files.length === 1
					? t("chat:fileChangesInConversation.diffTitleForFile", { path: files[0].path })
					: fallbackTitle
			openFileDiffs(files, title, fallbackTitle)
		},
		[t],
	)

	if (fileChanges.length === 0) return null

	const fileCount = byPath.size

	return (
		<Collapsible
			open={panelExpanded}
			onOpenChange={(open) => {
				onExpandedChange?.()
				setPanelExpanded(open)
			}}
			className={cn("mx-[15px] my-3 overflow-hidden rounded-xl border border-[var(--border-subtle)]", className)}>
			<div className="flex items-stretch bg-[var(--surface-raised)]">
				<CollapsibleTrigger
					ref={triggerRef}
					className={cn(
						"flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left text-vscode-foreground transition-colors",
						"hover:bg-vscode-list-hoverBackground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vscode-focusBorder",
					)}>
					<span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-vscode-editor-background text-vscode-descriptionForeground">
						<FileDiff className="size-4" aria-hidden />
					</span>
					<span className="flex min-w-0 flex-1 flex-col gap-1">
						<span className="text-sm font-semibold">
							{t("chat:fileChangesInConversation.header", { count: fileCount })}
						</span>
						{totalStats.added > 0 || totalStats.removed > 0 ? (
							<span
								className="flex items-center gap-2"
								aria-label={t("chat:fileChangesInConversation.linesChanged", {
									added: totalStats.added,
									removed: totalStats.removed,
								})}>
								<span
									className="text-xs font-medium text-vscode-charts-green"
									data-testid="total-added">
									+{totalStats.added}
								</span>
								<span
									className="text-xs font-medium text-vscode-charts-red"
									data-testid="total-removed">
									-{totalStats.removed}
								</span>
							</span>
						) : null}
					</span>
					{panelExpanded ? (
						<ChevronDown className="size-4 shrink-0 text-vscode-descriptionForeground" aria-hidden />
					) : (
						<ChevronRight className="size-4 shrink-0 text-vscode-descriptionForeground" aria-hidden />
					)}
				</CollapsibleTrigger>
				<button
					type="button"
					aria-label={t("chat:fileChangesInConversation.openAllDiffs")}
					onClick={() => openDiff(reviewFiles)}
					className="my-auto mr-3 shrink-0 rounded-lg border border-[var(--border-subtle)] bg-vscode-editor-background px-2.5 py-1 text-xs text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vscode-focusBorder">
					{t("chat:fileChangesInConversation.openAllDiffs")}
				</button>
			</div>
			<CollapsibleContent ref={contentRef}>
				<div className="border-t border-[var(--border-subtle)]">
					{reviewFiles.slice(0, showAllFiles ? undefined : 3).map((file) => {
						const stats = summariesByPath.get(file.path)!
						return (
							<button
								key={file.path}
								type="button"
								aria-label={t("chat:fileChangesInConversation.openDiff", { path: file.path })}
								onClick={() => openDiff([file])}
								className="flex w-full min-w-0 items-center gap-3 px-3 py-2 text-left text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vscode-focusBorder">
								<span className="min-w-0 flex-1 truncate" title={file.path}>
									{file.path}
								</span>
								{(stats.added > 0 || stats.removed > 0) && (
									<span className="flex shrink-0 gap-1 text-xs tabular-nums">
										<span className="text-vscode-charts-green">+{stats.added}</span>
										<span className="text-vscode-charts-red">-{stats.removed}</span>
									</span>
								)}
							</button>
						)
					})}
				</div>
				{fileCount > 3 && (
					<button
						type="button"
						onClick={() => {
							onExpandedChange?.()
							setShowAllFiles((value) => !value)
						}}
						className="flex w-full items-center gap-1 bg-[var(--surface-raised)] px-3 py-2 text-left text-sm hover:bg-vscode-list-hoverBackground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vscode-focusBorder">
						{t(showAllFiles ? "chat:task.seeLess" : "chat:task.seeMore")}
						<ChevronDown className={cn("size-3", showAllFiles && "rotate-180")} aria-hidden />
					</button>
				)}
			</CollapsibleContent>
		</Collapsible>
	)
})

FileChangesPanel.displayName = "FileChangesPanel"

export default FileChangesPanel
