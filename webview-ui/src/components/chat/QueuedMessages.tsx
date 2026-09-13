import { Fragment, useRef, useState } from "react"
import { useTranslation } from "react-i18next"
import { GripVertical, Pencil } from "lucide-react"

import { QueuedMessage } from "@alpha-code/types"

import { Button } from "@src/components/ui"

import Thumbnails from "../common/Thumbnails"

import { Mention } from "./Mention"

interface QueuedMessagesProps {
	queue: QueuedMessage[]
	onRemove: (index: number) => void
	onSteer: (index: number) => void
	onEdit: (index: number) => void
	onReorder: (fromIndex: number, toIndex: number) => void
	editingMessageId?: string
	steeringMessageId?: string
}

export const QueuedMessages = ({
	queue,
	onRemove,
	onSteer,
	onEdit,
	onReorder,
	editingMessageId,
	steeringMessageId,
}: QueuedMessagesProps) => {
	const { t } = useTranslation("chat")
	const draggedMessageIdRef = useRef<string | null>(null)
	const rowRefs = useRef(new Map<string, HTMLDivElement>())
	const [dropTargetIndex, setDropTargetIndex] = useState<number | null>(null)

	if (queue.length === 0) {
		return null
	}

	const resetDrag = () => {
		draggedMessageIdRef.current = null
		setDropTargetIndex(null)
	}

	const getDraggedIndex = () =>
		queue.findIndex((message) => message.id === draggedMessageIdRef.current && message.id !== editingMessageId)

	const getDropTargetIndex = (clientY: number): number => {
		for (const [index, message] of queue.entries()) {
			const rect = rowRefs.current.get(message.id)?.getBoundingClientRect()
			if (rect && clientY < rect.top + rect.height / 2) return index
		}
		return queue.length
	}

	const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
		if (steeringMessageId !== undefined || getDraggedIndex() < 0) return
		event.preventDefault()
		event.stopPropagation()
		event.dataTransfer.dropEffect = "move"
		setDropTargetIndex(getDropTargetIndex(event.clientY))
	}

	// Keep every gap in the layout so showing the line cannot move the drop targets.
	const renderDropIndicator = (position: number) => (
		<div data-testid={`queued-drop-zone-${position}`} className="flex h-3 shrink-0 items-center" aria-hidden="true">
			{dropTargetIndex === position && (
				<div
					data-testid="queued-drop-indicator"
					data-position={position}
					className="pointer-events-none mx-1 h-0.5 w-full rounded-full bg-[var(--alpha-accent)] shadow-[0_0_5px_var(--alpha-accent)]"
				/>
			)}
		</div>
	)

	return (
		<div
			className="px-[15px] py-[10px] pr-[6px]"
			data-testid="queued-messages"
			onDragEnter={handleDragOver}
			onDragOver={handleDragOver}
			onDrop={(e) => {
				const fromIndex = getDraggedIndex()
				resetDrag()
				if (steeringMessageId !== undefined || fromIndex < 0) return
				e.preventDefault()
				e.stopPropagation()
				const dropPosition = getDropTargetIndex(e.clientY)
				// The insertion slot includes the source row; the final index does not.
				const toIndex = dropPosition > fromIndex ? dropPosition - 1 : dropPosition
				if (toIndex !== fromIndex) onReorder(fromIndex, toIndex)
			}}
			onDragLeave={(e) => {
				if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) {
					setDropTargetIndex(null)
				}
			}}
			onDragEnd={resetDrag}>
			<div className="text-vscode-descriptionForeground text-md">{t("queuedMessages.title")}</div>
			<div className="flex flex-col max-h-[300px] overflow-y-auto pr-2">
				{queue.map((message, index) => {
					const isEditing = editingMessageId === message.id
					const isSteering = steeringMessageId === message.id
					const controlsDisabled = isEditing || steeringMessageId !== undefined

					return (
						<Fragment key={message.id}>
							{renderDropIndicator(index)}
							<div
								data-testid={`queued-message-${message.id}`}
								ref={(element) => {
									if (element) {
										rowRefs.current.set(message.id, element)
									} else {
										rowRefs.current.delete(message.id)
									}
								}}
								className={`flex-shrink-0 overflow-hidden whitespace-pre-wrap rounded-xl border bg-[var(--surface-sunken)] p-1 ${
									isEditing
										? "border-[var(--border-accent)] bg-[var(--alpha-accent-soft)] opacity-90"
										: "border-[var(--border-subtle)]"
								}`}>
								<div className="flex items-center justify-between gap-1">
									<button
										type="button"
										tabIndex={controlsDisabled ? -1 : 0}
										aria-label={t("queuedMessages.dragHandle")}
										title={t("queuedMessages.dragTooltip")}
										draggable={!controlsDisabled}
										className={`inline-flex h-7 shrink-0 items-center justify-center px-1 text-vscode-descriptionForeground ${
											controlsDisabled
												? "opacity-40 cursor-default"
												: "cursor-grab active:cursor-grabbing"
										} border-0 bg-transparent`}
										onDragStart={(e) => {
											if (controlsDisabled) {
												e.preventDefault()
												return
											}
											draggedMessageIdRef.current = message.id
											e.dataTransfer.effectAllowed = "move"
											e.dataTransfer.setData("text/plain", String(index))
										}}
										onKeyDown={(e) => {
											if (controlsDisabled || (e.key !== "ArrowUp" && e.key !== "ArrowDown"))
												return
											const targetIndex = e.key === "ArrowUp" ? index - 1 : index + 1
											if (targetIndex < 0 || targetIndex >= queue.length) return
											e.preventDefault()
											onReorder(index, targetIndex)
										}}
										onClick={(e) => e.stopPropagation()}>
										<GripVertical className="w-4 h-4" />
									</button>
									<div className="flex-grow px-2 py-1 wrap-anywhere">
										<div
											className={`px-1 py-0.5 -mx-1 -my-0.5 rounded transition-colors ${
												isEditing ? "bg-[var(--alpha-accent-soft)]" : ""
											}`}
											title={isEditing ? t("queuedMessages.editing") : undefined}>
											<Mention text={message.text} withShadow />
										</div>
										{isEditing && (
											<div className="mt-1 text-xs text-vscode-descriptionForeground">
												{t("queuedMessages.editing")}
											</div>
										)}
									</div>
									<div className="flex items-center">
										<Button
											variant="ghost"
											size="icon"
											className="shrink-0"
											title={t("queuedMessages.editTooltip")}
											aria-label={t("queuedMessages.editTooltip")}
											disabled={controlsDisabled}
											onClick={(e) => {
												e.stopPropagation()
												onEdit(index)
											}}>
											<Pencil className="w-4 h-4" />
										</Button>
										<Button
											variant="ghost"
											className="shrink-0 px-2"
											title={t("queuedMessages.steerTooltip")}
											disabled={controlsDisabled}
											onClick={(e) => {
												e.stopPropagation()
												onSteer(index)
											}}>
											{isSteering ? t("queuedMessages.steering") : t("queuedMessages.steer")}
										</Button>
										<Button
											variant="ghost"
											size="icon"
											className="shrink-0"
											disabled={controlsDisabled}
											aria-label={t("common:answers.remove")}
											title={t("common:answers.remove")}
											onClick={(e) => {
												e.stopPropagation()
												onRemove(index)
											}}>
											<span className="codicon codicon-trash" />
										</Button>
									</div>
								</div>
								{message.images && message.images.length > 0 && (
									<Thumbnails images={message.images} style={{ marginTop: "8px" }} />
								)}
							</div>
						</Fragment>
					)
				})}
				{renderDropIndicator(queue.length)}
			</div>
		</div>
	)
}
