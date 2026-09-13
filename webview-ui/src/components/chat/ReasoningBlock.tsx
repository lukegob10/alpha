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
	metadata?: any
}

export const ReasoningBlock = ({ content, isStreaming, isLast, collapsedByDefault }: ReasoningBlockProps) => {
	const { t } = useTranslation()
	const [isCollapsed, setIsCollapsed] = useState(collapsedByDefault ?? true)

	const startTimeRef = useRef<number>(Date.now())
	const [elapsed, setElapsed] = useState<number>(0)
	const contentRef = useRef<HTMLDivElement>(null)

	useEffect(() => {
		setIsCollapsed(collapsedByDefault ?? true)
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
		setIsCollapsed(!isCollapsed)
	}

	return (
		<ActivityStep
			isExpanded={!isCollapsed}
			onToggleExpand={handleToggle}
			summary={
				<>
					<Lightbulb className="w-4" />
					<span>{t("chat:reasoning.thinking")}</span>
					{elapsed > 0 && (
						<span className="text-sm text-vscode-descriptionForeground mt-0.5">{secondsLabel}</span>
					)}
				</>
			}>
			{(content?.trim()?.length ?? 0) > 0 && !isCollapsed && (
				<div
					ref={contentRef}
					className="border-l border-vscode-descriptionForeground/20 ml-2 pl-4 pb-1 text-vscode-descriptionForeground break-words">
					<MarkdownBlock markdown={content} partial={isLast && isStreaming} />
				</div>
			)}
		</ActivityStep>
	)
}
