import { useEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import MarkdownBlock from "../common/MarkdownBlock"
import { Lightbulb } from "lucide-react"
import { ActivityStep } from "./ActivityStep"

interface ReasoningBlockProps {
	content: string
	ts: number
	isStreaming: boolean
	isLast: boolean
	collapsedByDefault?: boolean
	isExpanded?: boolean
	onExpandedChange?: (expanded: boolean) => void
}

function ReasoningElapsed({ active, formatSeconds }: { active: boolean; formatSeconds: (seconds: number) => string }) {
	const startTimeRef = useRef(Date.now())
	const [elapsed, setElapsed] = useState(0)
	useEffect(() => {
		if (!active) return
		const tick = () => setElapsed(Date.now() - startTimeRef.current)
		tick()
		const id = setInterval(tick, 1000)
		return () => clearInterval(id)
	}, [active])

	return elapsed > 0 ? (
		<span className="shrink-0 text-xs tabular-nums text-vscode-descriptionForeground">
			{formatSeconds(Math.floor(elapsed / 1000))}
		</span>
	) : null
}

export const ReasoningBlock = ({
	content,
	isStreaming,
	isLast,
	collapsedByDefault,
	isExpanded: controlledExpanded,
	onExpandedChange,
}: ReasoningBlockProps) => {
	const { t } = useTranslation()
	const [localExpanded, setLocalExpanded] = useState(!(collapsedByDefault ?? true))
	const isExpanded = controlledExpanded ?? localExpanded

	const contentRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		setLocalExpanded(!(collapsedByDefault ?? true))
	}, [collapsedByDefault])

	const handleToggle = () => {
		const expanded = !isExpanded
		if (controlledExpanded === undefined) setLocalExpanded(expanded)
		onExpandedChange?.(expanded)
	}

	return (
		<ActivityStep
			active={isStreaming && isLast}
			isExpanded={isExpanded}
			onToggleExpand={handleToggle}
			summary={
				<>
					<Lightbulb aria-hidden="true" className="size-4 shrink-0" />
					<span>{t("chat:reasoning.thinking")}</span>
					<ReasoningElapsed
						active={isLast && isStreaming}
						formatSeconds={(count) => t("chat:reasoning.seconds", { count })}
					/>
				</>
			}>
			{isExpanded && (content?.trim()?.length ?? 0) > 0 && (
				<div
					ref={contentRef}
					className="border-l border-vscode-descriptionForeground/20 ml-2 pl-4 pb-1 text-vscode-descriptionForeground break-words">
					<MarkdownBlock markdown={content} partial={isLast && isStreaming} />
				</div>
			)}
		</ActivityStep>
	)
}
