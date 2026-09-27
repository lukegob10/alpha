import { memo, useEffect, useMemo, useState, useCallback, useRef, useId } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronRight, FileDiff, ArrowUpRight } from "lucide-react"
import { createTwoFilesPatch, diffLines } from "diff"

import type { AlphaMessage, ExtensionMessage } from "@alpha-code/types"

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
	clineMessages: AlphaMessage[] | undefined
	taskId?: string
	className?: string
	onExpandedChange?: () => void
}

function countChangedLines(originalContent: string, finalContent: string): { added: number; removed: number } {
	let added = 0
	let removed = 0
	for (const change of diffLines(originalContent, finalContent)) {
		if (change.added) added += change.count ?? 0
		if (change.removed) removed += change.count ?? 0
	}
	return { added, removed }
}

const FileChangesPanel = memo(({ clineMessages, taskId, className, onExpandedChange }: FileChangesPanelProps) => {
	const { t } = useTranslation()
	const [panelExpanded, setPanelExpanded] = useState(true)
	const [showAllFiles, setShowAllFiles] = useState(false)
	const panelId = useId()
	const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set())
	const [finalContentByPath, setFinalContentByPath] = useState<Record<string, string | null>>({})
	const pendingPathsRef = useRef<Set<string>>(new Set())
	const netStatsCacheRef = useRef(
		new Map<string, { originalContent: string; finalContent: string; stats: { added: number; removed: number } }>(),
	)

	// Reset expanded file rows and final content cache when switching to a different task
	useEffect(() => {
		setPanelExpanded(true)
		setShowAllFiles(false)
		setExpandedPaths(new Set())
		setFinalContentByPath({})
		pendingPathsRef.current = new Set()
		netStatsCacheRef.current.clear()
	}, [taskId])

	const fileChanges = useMemo(() => fileChangesFromMessages(clineMessages), [clineMessages])

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
		for (const [path, entries] of byPath) {
			const originalContent = entries[0].originalContent
			const finalContent = entries[entries.length - 1].finalContent
			if (originalContent !== undefined && finalContent !== undefined) {
				const cached = netStatsCacheRef.current.get(path)
				if (cached?.originalContent === originalContent && cached.finalContent === finalContent) {
					summaries.set(path, cached.stats)
				} else {
					const stats = countChangedLines(originalContent, finalContent)
					if (!netStatsCacheRef.current.has(path) && netStatsCacheRef.current.size >= 128) {
						const oldestPath = netStatsCacheRef.current.keys().next().value
						if (oldestPath !== undefined) netStatsCacheRef.current.delete(oldestPath)
					}
					netStatsCacheRef.current.set(path, { originalContent, finalContent, stats })
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

	const togglePath = useCallback(
		(path: string) => {
			onExpandedChange?.()
			setExpandedPaths((prev) => {
				const next = new Set(prev)
				if (next.has(path)) next.delete(path)
				else next.add(path)
				return next
			})
		},
		[onExpandedChange],
	)

	// Older edit records need a live read; completed records carry their own immutable final content.
	useEffect(() => {
		for (const path of expandedPaths) {
			const entries = byPath.get(path)
			if (!entries?.length) continue
			const originalContent = entries[0].originalContent
			const recordedFinalContent = entries[entries.length - 1].finalContent
			const lookupPath = path.startsWith("./") ? path.slice(2) : path
			if (
				originalContent !== undefined &&
				recordedFinalContent === undefined &&
				!(lookupPath in finalContentByPath) &&
				!pendingPathsRef.current.has(lookupPath)
			) {
				pendingPathsRef.current.add(lookupPath)
				vscode.postMessage({ type: "readFileContent", text: lookupPath })
			}
		}
	}, [expandedPaths, byPath, finalContentByPath])

	// Listen for fileContent responses
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message: ExtensionMessage = event.data
			if (message.type === "fileContent" && message.fileContent?.path != null) {
				const fc = message.fileContent
				pendingPathsRef.current.delete(fc.path)
				setFinalContentByPath((prev) => ({ ...prev, [fc.path]: fc.content ?? null }))
			}
		}
		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

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
			<CollapsibleTrigger
				className={cn(
					"flex w-full items-center gap-3 bg-[var(--surface-raised)] px-3 py-3 text-left text-vscode-foreground transition-colors",
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
							<span className="text-xs font-medium text-vscode-charts-green" data-testid="total-added">
								+{totalStats.added}
							</span>
							<span className="text-xs font-medium text-vscode-charts-red" data-testid="total-removed">
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
			<CollapsibleContent>
				<div className="border-t border-[var(--border-subtle)]">
					{Array.from(byPath.entries())
						.slice(0, showAllFiles ? undefined : 3)
						.map(([path, entries], index) => {
							const originalContent = entries[0].originalContent
							const lookupPath = path.startsWith("./") ? path.slice(2) : path
							const finalContent =
								entries[entries.length - 1].finalContent ?? finalContentByPath[lookupPath]
							const hasMergedDiff = originalContent !== undefined && finalContent != null
							const isExpanded = expandedPaths.has(path)
							const displayDiff = !isExpanded
								? ""
								: hasMergedDiff
									? createTwoFilesPatch(path, path, originalContent, finalContent)
									: entries.map((e) => e.diff).join("\n\n")
							const combinedStats = summariesByPath.get(path)!
							return (
								<div key={path} className="group/file">
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
										</button>
										<button
											type="button"
											aria-label={t("chat:fileChangesInConversation.openFile", { path })}
											onClick={() =>
												vscode.postMessage({
													type: "openFile",
													text: path.startsWith("./") ? path : "./" + path,
												})
											}
											className="ml-2 flex size-6 shrink-0 items-center justify-center rounded text-vscode-descriptionForeground opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100 focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
											<ArrowUpRight className="size-3.5" aria-hidden />
										</button>
									</div>
									<div
										id={`${panelId}-file-${index}`}
										hidden={!isExpanded}
										className="max-h-80 overflow-auto border-t border-[var(--border-subtle)]">
										{isExpanded && <DiffView source={displayDiff} filePath={path} />}
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
