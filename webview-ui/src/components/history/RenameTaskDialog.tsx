import { useEffect, useId, useRef, useState, type ComponentProps } from "react"
import type { ExtensionMessage, HistoryItem } from "@alpha-code/types"
import { getTaskDisplayName, taskRenameResultSchema } from "@alpha-code/types"

import {
	Button,
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	Input,
} from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"

export const TASK_RENAME_TIMEOUT_MS = 30_000

type RenameTaskDialogProps = {
	item: HistoryItem
	open: boolean
	onOpenChange: (open: boolean) => void
	onCloseAutoFocus?: ComponentProps<typeof DialogContent>["onCloseAutoFocus"]
}

/** Renames user-owned metadata only after the owning extension acknowledges the request. */
export function RenameTaskDialog({ item, open, onOpenChange, onCloseAutoFocus }: RenameTaskDialogProps) {
	const { t } = useAppTranslation()
	const inputId = useId()
	const inputRef = useRef<HTMLInputElement>(null)
	const requestRef = useRef<string | null>(null)
	const timeoutRef = useRef<number | undefined>(undefined)
	const [name, setName] = useState(() => getTaskDisplayName(item))
	const [pending, setPending] = useState(false)
	const [error, setError] = useState<string | null>(null)
	const trimmedName = name.trim()
	const latest = useRef({ onOpenChange, t, item })
	latest.current = { onOpenChange, t, item }

	useEffect(() => {
		if (open) {
			setName(getTaskDisplayName(latest.current.item))
			setError(null)
		}
		// A projection refresh must not overwrite text being edited.
	}, [open, item.id])

	useEffect(() => {
		const onMessage = (event: MessageEvent<ExtensionMessage>) => {
			if (event.data?.type !== "taskRenameResult") return
			const parsed = taskRenameResultSchema.safeParse(event.data.taskRenameResult)
			if (!parsed.success) return
			const result = parsed.data
			if (result.taskId !== item.id || result.requestId !== requestRef.current) return
			requestRef.current = null
			window.clearTimeout(timeoutRef.current)
			setPending(false)
			if (result.status === "success") latest.current.onOpenChange(false)
			else setError(latest.current.t(`history:renameErrors.${result.error}`))
		}
		window.addEventListener("message", onMessage)
		return () => {
			window.removeEventListener("message", onMessage)
			window.clearTimeout(timeoutRef.current)
			requestRef.current = null
		}
	}, [item.id])

	const save = () => {
		if (pending || requestRef.current || !trimmedName || trimmedName.length > 96) return
		const requestId = crypto.randomUUID()
		requestRef.current = requestId
		setPending(true)
		setError(null)
		timeoutRef.current = window.setTimeout(() => {
			requestRef.current = null
			setPending(false)
			setError(t("history:renameTimedOut"))
		}, TASK_RENAME_TIMEOUT_MS)
		vscode.postMessage({
			type: "renameTask",
			taskRenameRequest: { taskId: item.id, requestId, displayName: trimmedName },
		})
	}

	return (
		<Dialog open={open} onOpenChange={(nextOpen) => !pending && onOpenChange(nextOpen)}>
			<DialogContent
				className="max-w-[calc(100%-24px)] gap-4 p-5 sm:max-w-sm"
				onCloseAutoFocus={onCloseAutoFocus}
				onOpenAutoFocus={(event) => {
					event.preventDefault()
					inputRef.current?.focus()
					inputRef.current?.select()
				}}
				onEscapeKeyDown={(event) => {
					if (pending) event.preventDefault()
				}}>
				<DialogHeader>
					<DialogTitle>{t("history:renameChat")}</DialogTitle>
					<DialogDescription>{t("history:renameDescription")}</DialogDescription>
				</DialogHeader>
				<form
					className="flex min-w-0 flex-col gap-4"
					onSubmit={(event) => {
						event.preventDefault()
						save()
					}}>
					<label htmlFor={inputId} className="sr-only">
						{t("history:chatName")}
					</label>
					<Input
						ref={inputRef}
						id={inputId}
						value={name}
						maxLength={96}
						disabled={pending}
						aria-invalid={!!error}
						aria-describedby={error ? `${inputId}-error` : undefined}
						onChange={(event) => {
							setName(event.target.value)
							setError(null)
						}}
					/>
					{error && (
						<p id={`${inputId}-error`} role="alert" className="m-0 text-sm text-vscode-errorForeground">
							{error}
						</p>
					)}
					<DialogFooter>
						<Button
							type="button"
							variant="secondary"
							disabled={pending}
							onClick={() => onOpenChange(false)}>
							{t("history:cancel")}
						</Button>
						<Button
							type="submit"
							disabled={pending || !trimmedName || trimmedName.length > 96}
							aria-busy={pending}>
							{t(pending ? "history:saving" : "history:save")}
						</Button>
					</DialogFooter>
				</form>
			</DialogContent>
		</Dialog>
	)
}
