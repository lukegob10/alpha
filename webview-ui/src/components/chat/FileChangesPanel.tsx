import { memo, useEffect, useMemo, useState, useCallback, useRef, useId } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, FileDiff } from "lucide-react"
import { createTwoFilesPatch, diffLines } from "diff"

import type { AlphaMessage, OpenDiffFile } from "@alpha-code/types"

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui"
import { cn } from "@/lib/utils"
import { vscode } from "@src/utils/vscode"
import {
	fileChangesFromMessages,
	normalizedFileChangePath,
	type FileChangeEntry,
} from "./utils/fileChangesFromMessages"
import DiffView from "../common/DiffView"

interface FileChangesPanelProps {
	alphaMessages: AlphaMessage[] | undefined
	taskId?: string
	className?: string
	onExpandedChange?: () => void
}

// Larger reviews remain available inline; the host limits each native review request.
const MAX_NATIVE_DIFF_FILES = 128
const MAX_NATIVE_DIFF_TITLE_LENGTH = 256
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

interface CapturedDiffViewProps {
	filePath: string
	originalContent: string
	finalContent: string
}

// Transcript updates recreate the edit projection; unchanged snapshots retain their rendered patch.
const CapturedDiffView = memo(function CapturedDiffView({
	filePath,
	originalContent,
	finalContent,
}: CapturedDiffViewProps) {
	return (
		<DiffView source={createTwoFilesPatch(filePath, filePath, originalContent, finalContent)} filePath={filePath} />
	)
})

const FileChangesPanel = memo(({ alphaMessages, taskId, className, onExpandedChange }: FileChangesPanelProps) => {
	const { t } = useTranslation()
	const [panelExpanded, setPanelExpanded] = useState(false)
	const [showAllFiles, setShowAllFiles] = useState(false)
	const panelId = useId()
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
	const reviewInitializedRef = useRef(false)
	const userToggledPathsRef = useRef(new Set<string>())
	const netStatsCacheRef = useRef(
		new Map<string, { originalContent: string; finalContent: string; stats: { added: number; removed: number } }>(),
	)

	// Reset disclosure state and derived stats when switching to a different task
	useEffect(() => {
		setPanelExpanded(false)
		setShowAllFiles(false)
		setExpandedPaths(new Set())
		reviewInitializedRef.current = false
		userToggledPathsRef.current.clear()
		netStatsCacheRef.current.clear()
	}, [taskId])

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

	const diffFilesByPath = useMemo(() => {
		const snapshots = new Map<string, OpenDiffFile>()
		for (const [path, entries] of byPath) {
			const originalContent = entries[0].originalContent
			const finalContent = entries[entries.length - 1].finalContent
			if (originalContent !== undefined && finalContent !== undefined) {
				snapshots.set(path, { path, originalContent, finalContent })
			}
		}
		return snapshots
	}, [byPath])

	const openDiff = useCallback(
		(files: OpenDiffFile[]) => {
			if (files.length === 0 || files.length > MAX_NATIVE_DIFF_FILES) return
			const title =
				files.length === 1
					? t("chat:fileChangesInConversation.diffTitleForFile", { path: files[0].path })
					: t("chat:fileChangesInConversation.diffTitle")
			vscode.postMessage({
				type: "openDiff",
				payload: {
					title:
						title.length <= MAX_NATIVE_DIFF_TITLE_LENGTH
							? title
							: t("chat:fileChangesInConversation.diffTitle"),
					files,
				},
			})
		},
		[t],
	)

	const reviewChanges = useCallback(() => {
		const files = Array.from(diffFilesByPath.values())
		openDiff(files)
		if (byPath.size === 1 && files.length > 0) return

		onExpandedChange?.()
		setPanelExpanded(true)
		setShowAllFiles(true)
		// Initialize the bottom displayed file once; explicit choices before Review also remain authoritative.
		if (!reviewInitializedRef.current) {
			reviewInitializedRef.current = true
			const bottomPath = Array.from(byPath.keys()).at(-1)
			if (bottomPath && !userToggledPathsRef.current.has(bottomPath)) {
				setExpandedPaths((previous) => new Set(previous).add(bottomPath))
			}
		}
	}, [byPath, diffFilesByPath, onExpandedChange, openDiff])

	const togglePath = useCallback(
		(path: string) => {
			onExpandedChange?.()
			userToggledPathsRef.current.add(path)
			setExpandedPaths((prev) => {
				const next = new Set(prev)
				if (next.has(path)) next.delete(path)
				else next.add(path)
				return next
			})
		},
		[onExpandedChange],
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
					onClick={reviewChanges}
					className="my-auto mr-3 shrink-0 rounded-lg border border-[var(--border-subtle)] bg-vscode-editor-background px-2.5 py-1 text-xs text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-vscode-focusBorder">
					{t("chat:fileChangesInConversation.openAllDiffs")}
				</button>
			</div>
			<CollapsibleContent>
				<div className="border-t border-[var(--border-subtle)]">
					{Array.from(byPath.entries())
						.slice(0, showAllFiles ? undefined : 3)
						.map(([path, entries], index) => {
							const originalContent = entries[0].originalContent
							const finalContent = entries[entries.length - 1].finalContent
							const diffSnapshot = diffFilesByPath.get(path)
							const isExpanded = expandedPaths.has(path)
							const combinedStats = summariesByPath.get(path)!
							return (
								<div key={path}>
									<div className="flex items-center px-3 hover:bg-vscode-list-hoverBackground">
										<button
											type="button"
											aria-expanded={isExpanded}
											aria-controls={`${panelId}-file-${index}`}
											onClick={() => togglePath(path)}
											className="flex min-w-0 flex-1 items-center gap-3 py-2 text-left text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
											<span className="min-w-0 flex-1 truncate" title={path}>
												{path}
											</span>
										</button>
										<button
											type="button"
											aria-label={t("chat:fileChangesInConversation.openDiff", { path })}
											aria-expanded={diffSnapshot ? undefined : isExpanded}
											aria-controls={diffSnapshot ? undefined : `${panelId}-file-${index}`}
											onClick={() => {
												if (diffSnapshot) openDiff([diffSnapshot])
												else togglePath(path)
											}}
											className="ml-2 flex h-6 shrink-0 items-center gap-2 rounded px-1 text-vscode-descriptionForeground hover:text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
											{(combinedStats.added > 0 || combinedStats.removed > 0) && (
												<span className="flex shrink-0 gap-1 text-xs tabular-nums">
													<span className="text-vscode-charts-green">
														+{combinedStats.added}
													</span>
													<span className="text-vscode-charts-red">
														-{combinedStats.removed}
													</span>
												</span>
											)}
											<FileDiff className="size-3.5" aria-hidden />
										</button>
									</div>
									<div
										id={`${panelId}-file-${index}`}
										hidden={!isExpanded}
										className="max-h-80 overflow-auto border-t border-[var(--border-subtle)]">
										{isExpanded &&
											(originalContent !== undefined && finalContent != null ? (
												<CapturedDiffView
													filePath={path}
													originalContent={originalContent}
													finalContent={finalContent}
												/>
											) : (
												<DiffView
													source={entries.map((entry) => entry.diff).join("\n\n")}
													filePath={path}
												/>
											))}
									</div>
								</div>
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
