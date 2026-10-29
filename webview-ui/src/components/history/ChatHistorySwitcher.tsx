import { memo, useEffect, useRef, useState } from "react"
import { ArrowLeft, PanelsTopLeft } from "lucide-react"

import { Button, Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import HistoryPreview from "./HistoryPreview"
import { cn } from "@/lib/utils"

export type ChatHistorySwitcherProps = {
	currentTaskId?: string
	onBackToHome: () => void
	onOpenTask: (taskId: string) => void
	onViewAll?: () => void
	className?: string
	isVisible?: boolean
}

const controlClassName =
	"size-6 shrink-0 rounded-md p-1 text-vscode-descriptionForeground hover:bg-vscode-toolbar-hoverBackground hover:text-vscode-foreground"

/** Ephemeral navigation UI; task selection remains owned by the extension. */
function ChatHistorySwitcher({
	currentTaskId,
	onBackToHome,
	onOpenTask,
	onViewAll,
	className,
	isVisible = true,
}: ChatHistorySwitcherProps) {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const contentRef = useRef<HTMLDivElement>(null)
	useEffect(() => {
		setOpen(false)
	}, [currentTaskId, isVisible])

	// ChatView remains mounted behind secondary views; portals must follow its visibility.
	if (!isVisible) return null

	return (
		<div className={cn("chat-history-switcher flex min-w-0 flex-1 items-center gap-1", className)}>
			<StandardTooltip content={t("history:backToHome")}>
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className={controlClassName}
					aria-label={t("history:backToHome")}
					onClick={() => {
						setOpen(false)
						onBackToHome()
					}}>
					<ArrowLeft className="size-4" aria-hidden="true" />
				</Button>
			</StandardTooltip>
			<Popover open={open} onOpenChange={setOpen}>
				<StandardTooltip content={t("history:switchChat")}>
					<PopoverTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className={controlClassName}
							aria-label={t("history:switchChat")}>
							<PanelsTopLeft className="size-4" aria-hidden="true" />
						</Button>
					</PopoverTrigger>
				</StandardTooltip>
				<PopoverContent
					ref={contentRef}
					align="start"
					className="w-[min(356px,calc(100vw-24px))] p-2"
					aria-label={t("history:switchChat")}
					onOpenAutoFocus={(event) => {
						event.preventDefault()
						queueMicrotask(() =>
							contentRef.current?.querySelector<HTMLElement>("[data-testid^=task-item-]")?.focus(),
						)
					}}
					onInteractOutside={(event) => {
						// Row action dialogs and menus are portalled outside this popover.
						if (
							event.target instanceof Element &&
							event.target.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')
						)
							event.preventDefault()
					}}
					onKeyDown={(event) => {
						if (
							(event.key !== "Home" &&
								event.key !== "End" &&
								event.key !== "ArrowDown" &&
								event.key !== "ArrowUp") ||
							!(event.target instanceof HTMLElement) ||
							!event.target.dataset.testid?.startsWith("task-item-")
						)
							return
						const rows = Array.from(
							contentRef.current?.querySelectorAll<HTMLElement>('[data-testid^="task-item-"]') ?? [],
						)
						const current = rows.indexOf(event.target)
						const next =
							event.key === "Home"
								? 0
								: event.key === "End"
									? rows.length - 1
									: event.key === "ArrowDown"
										? (current + 1) % rows.length
										: event.key === "ArrowUp"
											? (current + rows.length - 1) % rows.length
											: -1
						if (next >= 0) {
							event.preventDefault()
							rows[next]?.focus()
						}
					}}>
					<div data-chat-switcher>
						<HistoryPreview
							onOpenTask={(taskId) => {
								setOpen(false)
								onOpenTask(taskId)
							}}
							onExpand={() => {
								setOpen(false)
								onViewAll?.()
							}}
						/>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	)
}

export default memo(ChatHistorySwitcher)
