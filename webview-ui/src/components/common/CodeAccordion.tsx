import { memo, useId, useMemo } from "react"
import { VSCodeProgressRing } from "@vscode/webview-ui-toolkit/react"
import { type ToolProgressStatus } from "@alpha-code/types"
import { getLanguageFromPath } from "@src/utils/getLanguageFromPath"
import { formatPathTooltip } from "@src/utils/formatPathTooltip"

import { ToolUseBlock, ToolUseBlockHeader } from "./ToolUseBlock"
import CodeBlock from "./CodeBlock"
import { PathTooltip } from "../ui/PathTooltip"
import DiffView from "./DiffView"

interface CodeAccordionProps {
	path?: string
	code?: string
	language: string
	progressStatus?: ToolProgressStatus
	isLoading?: boolean
	isExpanded: boolean
	isFeedback?: boolean
	onToggleExpand: () => void
	header?: string
	onJumpToFile?: () => void
	// New props for diff stats
	diffStats?: { added: number; removed: number }
}

const CodeAccordion = ({
	path,
	code = "",
	language,
	progressStatus,
	isLoading,
	isExpanded,
	isFeedback,
	onToggleExpand,
	header,
	onJumpToFile,
	diffStats,
}: CodeAccordionProps) => {
	const detailsId = useId()
	const inferredLanguage = useMemo(() => language ?? (path ? getLanguageFromPath(path) : "txt"), [path, language])
	const source = useMemo(() => code.trim(), [code])
	const hasHeader = Boolean(path || isFeedback || header)

	// Use provided diff stats only (render-only)
	const derivedStats = useMemo(() => {
		if (diffStats && (diffStats.added > 0 || diffStats.removed > 0)) return diffStats
		return null
	}, [diffStats])

	const hasValidStats = Boolean(derivedStats && (derivedStats.added > 0 || derivedStats.removed > 0))

	return (
		<ToolUseBlock>
			{hasHeader && (
				<ToolUseBlockHeader className="group min-w-0">
					<button
						type="button"
						aria-expanded={isExpanded}
						aria-controls={detailsId}
						onClick={onToggleExpand}
						className="flex min-w-0 flex-1 items-center rounded-sm text-left focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
						{isLoading && <VSCodeProgressRing className="size-3 mr-2" />}
						{header ? (
							<span className="flex min-w-0 items-center">
								<span aria-hidden="true" className="codicon codicon-server mr-1.5" />
								<PathTooltip content={header}>
									<span className="whitespace-nowrap overflow-hidden text-ellipsis mr-2">
										{header}
									</span>
								</PathTooltip>
							</span>
						) : isFeedback ? (
							<span className="flex min-w-0 items-center">
								<span aria-hidden="true" className="codicon codicon-feedback mr-1.5" />
								<span className="whitespace-nowrap overflow-hidden text-ellipsis mr-2 rtl">
									User Edits
								</span>
							</span>
						) : (
							<>
								{path?.startsWith(".") && <span>.</span>}
								<PathTooltip content={formatPathTooltip(path)}>
									<span className="whitespace-nowrap overflow-hidden text-ellipsis text-left mr-2 rtl">
										{formatPathTooltip(path)}
									</span>
								</PathTooltip>
							</>
						)}
						<span className="flex-1" />
						{/* Prefer diff stats over generic progress indicator if available */}
						{hasValidStats ? (
							<span className="flex shrink-0 items-center gap-2 mr-1">
								<span className="text-xs font-medium text-vscode-charts-green">
									+{derivedStats!.added}
								</span>
								<span className="text-xs font-medium text-vscode-charts-red">
									-{derivedStats!.removed}
								</span>
							</span>
						) : (
							progressStatus &&
							progressStatus.text && (
								<>
									{progressStatus.icon && (
										<span
											aria-hidden="true"
											className={`codicon codicon-${progressStatus.icon} mr-1`}
										/>
									)}
									<span className="mr-1 ml-auto text-vscode-descriptionForeground">
										{progressStatus.text}
									</span>
								</>
							)
						)}
						{!onJumpToFile && (
							<span
								aria-hidden="true"
								className={`shrink-0 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 codicon codicon-chevron-${isExpanded ? "up" : "down"}`}
							/>
						)}
					</button>
					{onJumpToFile && path && (
						<button
							type="button"
							className="flex shrink-0 items-center rounded-sm p-1 focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder"
							onClick={(e) => {
								e.stopPropagation()
								onJumpToFile()
							}}
							aria-label={`Open file: ${path}`}>
							<span
								aria-hidden="true"
								className="codicon codicon-link-external"
								style={{ fontSize: 13.5 }}
							/>
						</button>
					)}
				</ToolUseBlockHeader>
			)}
			<div
				id={detailsId}
				hidden={hasHeader && !isExpanded}
				className="overflow-x-auto overflow-y-auto max-h-[300px] max-w-full">
				{(!hasHeader || isExpanded) &&
					(inferredLanguage === "diff" ? (
						<DiffView source={source} filePath={path} />
					) : (
						<CodeBlock source={source} language={inferredLanguage} />
					))}
			</div>
		</ToolUseBlock>
	)
}

export default memo(CodeAccordion)
