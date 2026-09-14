import { useId, useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { ChevronDown, ChevronUp } from "lucide-react"

import { Mention } from "./Mention"

const PREVIEW_LINES = 6
const LINE_HEIGHT = 1.6

interface UserMessageTextProps {
	text?: string
	isExpanded: boolean
	onToggleExpand: () => void
	onEdit?: () => void
}

export function UserMessageText({ text, isExpanded, onToggleExpand, onEdit }: UserMessageTextProps) {
	const { t } = useTranslation()
	const contentId = useId()
	const textRef = useRef<HTMLDivElement>(null)
	const [overflows, setOverflows] = useState(false)
	const isCollapsed = overflows && !isExpanded

	useLayoutEffect(() => {
		const element = textRef.current
		if (!element) return

		const measure = () => {
			// Measure the natural text height so wrapping, font size, and explicit newlines share one cutoff.
			if (element.clientWidth === 0) return
			const lineHeight = Number.parseFloat(getComputedStyle(element).lineHeight)
			setOverflows(element.scrollHeight > lineHeight * PREVIEW_LINES + 1)
		}
		measure()
		const observer = new ResizeObserver(measure)
		observer.observe(element)
		return () => observer.disconnect()
	}, [text])

	return (
		<div className="min-w-0" style={{ lineHeight: LINE_HEIGHT }}>
			<div
				id={contentId}
				className="overflow-hidden scroll-mt-4"
				style={{ maxHeight: isExpanded ? undefined : `${PREVIEW_LINES * LINE_HEIGHT}em` }}>
				<div
					ref={textRef}
					className="wrap-anywhere whitespace-pre-wrap"
					onClick={(event) => {
						event.stopPropagation()
						if (window.getSelection()?.toString()) return
						if (
							event.target instanceof Element &&
							event.target.closest("button, [class*='mention-context-highlight']")
						)
							return
						if (isCollapsed) onToggleExpand()
						else onEdit?.()
					}}
					title={!isCollapsed && onEdit ? t("chat:queuedMessages.clickToEdit") : undefined}>
					{/* A collapsed preview has no clipped, focusable mention controls; expand to interact with mentions. */}
					{isCollapsed ? text : <Mention text={text} withShadow />}
				</div>
			</div>
			{overflows && (
				<button
					type="button"
					aria-expanded={isExpanded}
					aria-controls={contentId}
					onClick={(event) => {
						event.stopPropagation()
						// Move to the message before shrinking it, so the browser cannot clamp the old scroll offset past it.
						if (isExpanded)
							textRef.current?.parentElement?.scrollIntoView({ block: "start", behavior: "instant" })
						onToggleExpand()
					}}
					className="-ms-2 mt-2 flex w-fit cursor-pointer items-center gap-1 rounded-md border-0 bg-transparent px-2 py-1 text-xs font-medium text-inherit hover:underline focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
					{isExpanded ? t("chat:task.seeLess") : t("chat:task.seeMore")}
					{isExpanded ? (
						<ChevronUp size={14} aria-hidden="true" />
					) : (
						<ChevronDown size={14} aria-hidden="true" />
					)}
				</button>
			)}
		</div>
	)
}
