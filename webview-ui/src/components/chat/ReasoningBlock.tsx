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

	const startTimeRef = useRef<number>(Date.now())
	const [elapsed, setElapsed] = useState<number>(0)
	const contentRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		setLocalExpanded(!(collapsedByDefault ?? true))
	}, [collapsedByDefault])

	useEffect(() => {
		if (isLast && isStreaming) {
			const tick = () => setElapsed(Date.now() - startTimeRef.current)
			tick()
			const id = setInterval(tick, 1000)
			return () => clearInterval(id)
		}
	}, [isLast, isStreaming])

	const seconds = Math.floor(elapsed / 1000)
	const secondsLabel = t("chat:reasoning.seconds", { count: seconds })

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
					{elapsed > 0 && (
						<span className="shrink-0 text-xs tabular-nums text-vscode-descriptionForeground">
							{secondsLabel}
						</span>
					)}
				</>
			}>
			{(content?.trim()?.length ?? 0) > 0 && isExpanded && (
				<div
					ref={contentRef}
					className="border-l border-vscode-descriptionForeground/20 ml-2 pl-4 pb-1 text-vscode-descriptionForeground break-words">
					<MarkdownBlock markdown={content} partial={isLast && isStreaming} />
				</div>
			)}
		</ActivityStep>
	)
}
