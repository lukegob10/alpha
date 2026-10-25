import { useId, useLayoutEffect, useRef, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"

import { cn } from "@/lib/utils"

interface ActivityStepProps {
	summary: ReactNode
	description?: ReactNode
	children: ReactNode
	isExpanded: boolean
	active?: boolean
	onToggleExpand: () => void
}

/** Keep tool listeners and approval state mounted while the reader hides the details. */
export function ActivityStep({
	summary,
	description,
	children,
	isExpanded,
	active = false,
	onToggleExpand,
}: ActivityStepProps) {
	const detailsId = useId()
	const toggleRef = useRef<HTMLButtonElement>(null)
	const detailsRef = useRef<HTMLDivElement>(null)
	const focusedDetailRef = useRef<HTMLElement>()
	const isAnimating = active && !isExpanded
	useLayoutEffect(() => {
		if (isExpanded) return
		const focusedDetail = focusedDetailRef.current
		focusedDetailRef.current = undefined
		if (!focusedDetail || (focusedDetail.isConnected && !focusedDetail.closest("[hidden]"))) return
		const focused = document.activeElement
		const toggle = toggleRef.current
		if (
			toggle &&
			!toggle.closest("[hidden]") &&
			(focused === document.body || focused === focusedDetail || detailsRef.current?.contains(focused))
		) {
			toggle.focus({ preventScroll: true })
		}
	}, [isExpanded])

	return (
		<div>
			<button
				ref={toggleRef}
				type="button"
				aria-expanded={isExpanded}
				aria-busy={active || undefined}
				aria-controls={detailsId}
				onClick={onToggleExpand}
				className="activity-row-header flex w-full min-w-0 items-center gap-2 rounded-md py-1 text-left text-sm text-vscode-descriptionForeground hover:text-vscode-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder">
				<ChevronRight
					aria-hidden="true"
					className={cn(
						"activity-row-disclosure size-3.5 shrink-0",
						description && "mt-0.5 self-start",
						isExpanded && "rotate-90",
					)}
				/>
				<span className="min-w-0 flex-1">
					<span
						className={cn(
							"activity-row-summary flex min-w-0 items-center gap-2 [&>span]:truncate",
							isAnimating &&
								"activity-step-toggle w-fit max-w-full rounded-md activity-step-toggle--active",
						)}>
						{summary}
					</span>
					{description && (
						<span className="mt-1 line-clamp-3 whitespace-normal break-words text-xs leading-relaxed">
							{description}
						</span>
					)}
				</span>
			</button>
			<div
				ref={detailsRef}
				id={detailsId}
				hidden={!isExpanded}
				onFocusCapture={(event) => {
					focusedDetailRef.current = event.target
				}}
				onBlurCapture={(event) => {
					if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return
					const focusedDetail = focusedDetailRef.current
					// Keep an identity through collapse/unmount, but forget deliberate focus moves.
					if (focusedDetail?.isConnected && !focusedDetail.closest("[hidden]")) {
						focusedDetailRef.current = undefined
					}
				}}
				className="mt-2">
				{children}
			</div>
		</div>
	)
}
