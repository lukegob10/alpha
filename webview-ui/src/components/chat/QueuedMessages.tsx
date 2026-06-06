import { useRef, useState } from "react"
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
}

export const QueuedMessages = ({
	queue,
	onRemove,
	onSteer,
	onEdit,
	onReorder,
	editingMessageId,
}: QueuedMessagesProps) => {
	const { t } = useTranslation("chat")
	const draggedIndexRef = useRef<number | null>(null)
	const [dragOverIndex, setDragOverIndex] = useState<number | null>(null)

	if (queue.length === 0) {
		return null
	}

	return (
		<div className="px-[15px] py-[10px] pr-[6px]" data-testid="queued-messages">
			<div className="text-vscode-descriptionForeground text-md mb-2">{t("queuedMessages.title")}</div>
			<div className="flex flex-col gap-2 max-h-[300px] overflow-y-auto pr-2">
				{queue.map((message, index) => {
					const isEditing = editingMessageId === message.id

					return (
						<div
							key={message.id}
							data-testid={`queued-message-${message.id}`}
							onDragOver={(e) => {
								if (!isEditing) {
									e.preventDefault()
									e.dataTransfer.dropEffect = "move"
									setDragOverIndex(index)
								}
							}}
							onDrop={(e) => {
								e.preventDefault()
								const storedIndex = e.dataTransfer.getData("text/plain")
								const fromIndex = storedIndex ? Number(storedIndex) : draggedIndexRef.current
								draggedIndexRef.current = null
								setDragOverIndex(null)
								if (Number.isInteger(fromIndex) && fromIndex !== index) {
									onReorder(fromIndex as number, index)
								}
							}}
							onDragLeave={() => setDragOverIndex((current) => (current === index ? null : current))}
							className={`bg-vscode-editor-background border rounded-xs p-1 overflow-hidden whitespace-pre-wrap flex-shrink-0 ${
								isEditing ? "border-vscode-focusBorder opacity-80" : ""
							} ${
								dragOverIndex === index ? "border-vscode-focusBorder" : ""
							}`}>
							<div className="flex items-center justify-between gap-1">
								<div
									role="button"
									tabIndex={isEditing ? -1 : 0}
									aria-label={t("queuedMessages.dragHandle")}
									title={t("queuedMessages.dragTooltip")}
									draggable={!isEditing}
									className={`inline-flex h-7 shrink-0 items-center justify-center px-1 text-vscode-descriptionForeground ${
										isEditing ? "opacity-40 cursor-default" : "cursor-grab active:cursor-grabbing"
									}`}
									onDragStart={(e) => {
										if (isEditing) {
											e.preventDefault()
											return
										}
										draggedIndexRef.current = index
										e.dataTransfer.effectAllowed = "move"
										e.dataTransfer.setData("text/plain", String(index))
									}}
									onDragEnd={() => {
										draggedIndexRef.current = null
										setDragOverIndex(null)
									}}
									onClick={(e) => e.stopPropagation()}>
									<GripVertical className="w-4 h-4" />
								</div>
								<div className="flex-grow px-2 py-1 wrap-anywhere">
									<div
										className={`px-1 py-0.5 -mx-1 -my-0.5 rounded transition-colors ${
											isEditing ? "bg-vscode-list-activeSelectionBackground" : ""
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
										disabled={isEditing}
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
										disabled={isEditing}
										onClick={(e) => {
											e.stopPropagation()
											onSteer(index)
										}}>
										{t("queuedMessages.steer")}
									</Button>
									<Button
										variant="ghost"
										size="icon"
										className="shrink-0"
										disabled={isEditing}
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
					)
				})}
			</div>
		</div>
	)
}
