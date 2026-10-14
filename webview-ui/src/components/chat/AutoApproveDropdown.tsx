import React from "react"
import { Settings, ChevronDown } from "lucide-react"
import { type ApprovalMode, migrateApprovalMode, taskApprovalModeUpdateResultSchema } from "@alpha-code/types"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { useShellState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useAlphaPortal } from "@/components/ui/hooks/useAlphaPortal"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip, Button } from "@/components/ui"

interface AutoApproveDropdownProps {
	disabled?: boolean
	triggerClassName?: string
	isDraft?: boolean
	draftApprovalMode?: ApprovalMode
	onDraftApprovalModeChange?: (mode: ApprovalMode) => void
}

const MODES: ApprovalMode[] = ["ask", "auto", "bypass"]
const APPROVAL_MODE_UPDATE_TIMEOUT_MS = 15_000

export const AutoApproveDropdown = ({
	disabled = false,
	triggerClassName = "",
	isDraft = false,
	draftApprovalMode,
	onDraftApprovalModeChange,
}: AutoApproveDropdownProps) => {
	const [open, setOpen] = React.useState(false)
	const [bypassWarningOpen, setBypassWarningOpen] = React.useState(false)
	const [taskModeOverrides, setTaskModeOverrides] = React.useState<Record<string, ApprovalMode>>({})
	const [pendingUpdates, setPendingUpdates] = React.useState<Record<string, string>>({})
	const [updateFailures, setUpdateFailures] = React.useState<
		Record<string, "targetUnavailable" | "rejected" | "timedOut">
	>({})
	const pendingTaskByRequest = React.useRef(new Map<string, string>())
	const pendingRequestByTask = React.useRef(new Map<string, string>())
	const pendingTimeouts = React.useRef(new Map<string, ReturnType<typeof setTimeout>>())
	const portalContainer = useAlphaPortal("alpha-portal")
	const { t } = useAppTranslation()
	const state = useShellState()
	const {
		currentTaskId,
		currentTaskApprovalMode,
		approvalMode,
		approvalModeBypassAcknowledged,
		autoApprovalEnabled,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		alwaysAllowExecute,
		alwaysAllowTickets,
		alwaysAllowMcp,
		alwaysAllowSubagents,
		allowedCommands,
	} = state

	const defaultMode = migrateApprovalMode({
		approvalMode,
		autoApprovalEnabled,
		alwaysAllowWrite,
		alwaysAllowWriteOutsideWorkspace,
		alwaysAllowWriteProtected,
		alwaysAllowExecute,
		alwaysAllowTickets,
		alwaysAllowMcp,
		alwaysAllowSubagents,
		allowedCommands,
	})
	const targetTaskId = isDraft ? undefined : currentTaskId
	const mode = isDraft
		? (draftApprovalMode ?? defaultMode)
		: targetTaskId
			? (currentTaskApprovalMode ?? taskModeOverrides[targetTaskId] ?? defaultMode)
			: defaultMode
	const failureForCurrentTask = targetTaskId ? updateFailures[targetTaskId] : undefined
	const isUpdatingCurrentTask = Boolean(targetTaskId && pendingUpdates[targetTaskId])
	const canChangeMode = isDraft ? Boolean(onDraftApprovalModeChange) : Boolean(targetTaskId)

	const settlePendingUpdate = React.useCallback((requestId: string) => {
		const taskId = pendingTaskByRequest.current.get(requestId)
		if (!taskId) return undefined

		pendingTaskByRequest.current.delete(requestId)
		if (pendingRequestByTask.current.get(taskId) === requestId) {
			pendingRequestByTask.current.delete(taskId)
		}
		const timeout = pendingTimeouts.current.get(requestId)
		if (timeout !== undefined) {
			clearTimeout(timeout)
			pendingTimeouts.current.delete(requestId)
		}
		setPendingUpdates((previous) => {
			if (previous[taskId] !== requestId) return previous
			const next = { ...previous }
			delete next[taskId]
			return next
		})
		return taskId
	}, [])

	React.useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const data = event.data as { type?: unknown; taskApprovalModeUpdateResult?: unknown }
			if (data?.type !== "taskApprovalModeUpdated") return

			const rawResult = data.taskApprovalModeUpdateResult
			if (!rawResult || typeof rawResult !== "object" || !("requestId" in rawResult)) return
			const requestId = (rawResult as { requestId?: unknown }).requestId
			if (typeof requestId !== "string") return
			const taskId = settlePendingUpdate(requestId)
			if (!taskId) return

			const parsed = taskApprovalModeUpdateResultSchema.safeParse(rawResult)
			if (!parsed.success || (parsed.data.taskId && parsed.data.taskId !== taskId)) {
				setUpdateFailures((previous) => ({ ...previous, [taskId]: "rejected" }))
				return
			}

			const result = parsed.data
			if (result.status === "applied" && result.approvalMode !== undefined) {
				setTaskModeOverrides((previous) => ({ ...previous, [taskId]: result.approvalMode! }))
				setUpdateFailures((previous) => {
					const next = { ...previous }
					delete next[taskId]
					return next
				})
				if (currentTaskId === taskId) setOpen(false)
				return
			}

			setUpdateFailures((previous) => ({
				...previous,
				[taskId]: result.status === "targetUnavailable" ? "targetUnavailable" : "rejected",
			}))
		}

		window.addEventListener("message", handleMessage)
		return () => window.removeEventListener("message", handleMessage)
	}, [currentTaskId, settlePendingUpdate])

	React.useEffect(
		() => () => {
			for (const timeout of pendingTimeouts.current.values()) clearTimeout(timeout)
			pendingTimeouts.current.clear()
		},
		[],
	)

	const applyMode = React.useCallback(
		(next: ApprovalMode) => {
			if (isDraft) {
				onDraftApprovalModeChange?.(next)
				setOpen(false)
				return
			}
			if (!targetTaskId || pendingRequestByTask.current.has(targetTaskId)) return
			const requestId = crypto.randomUUID()
			pendingTaskByRequest.current.set(requestId, targetTaskId)
			pendingRequestByTask.current.set(targetTaskId, requestId)
			setPendingUpdates((previous) => ({ ...previous, [targetTaskId]: requestId }))
			setUpdateFailures((previous) => {
				const next = { ...previous }
				delete next[targetTaskId]
				return next
			})
			const timeout = setTimeout(() => {
				const taskId = settlePendingUpdate(requestId)
				if (taskId) setUpdateFailures((previous) => ({ ...previous, [taskId]: "timedOut" }))
			}, APPROVAL_MODE_UPDATE_TIMEOUT_MS)
			pendingTimeouts.current.set(requestId, timeout)
			vscode.postMessage({
				type: "setTaskApprovalMode",
				taskApprovalModeUpdate: { requestId, taskId: targetTaskId, approvalMode: next },
			})
		},
		[isDraft, onDraftApprovalModeChange, settlePendingUpdate, targetTaskId],
	)

	const selectMode = React.useCallback(
		(next: ApprovalMode) => {
			if (
				!canChangeMode ||
				(!isDraft && targetTaskId !== undefined && pendingRequestByTask.current.has(targetTaskId))
			)
				return
			if (next === "bypass" && mode !== "bypass" && approvalModeBypassAcknowledged !== true) {
				setBypassWarningOpen(true)
				return
			}
			applyMode(next)
		},
		[applyMode, approvalModeBypassAcknowledged, canChangeMode, isDraft, mode, targetTaskId],
	)

	const handleOpenSettings = React.useCallback(
		() =>
			window.postMessage({ type: "action", action: "settingsButtonClicked", values: { section: "autoApprove" } }),
		[],
	)

	return (
		<>
			<Popover open={open} onOpenChange={setOpen} data-testid="auto-approve-dropdown-root">
				<StandardTooltip
					content={
						targetTaskId
							? t("chat:autoApprove.tooltipMode", { mode: t(`chat:autoApprove.modes.${mode}`) })
							: isDraft
								? t("chat:autoApprove.tooltipDraftMode", { mode: t(`chat:autoApprove.modes.${mode}`) })
								: t("chat:autoApprove.tooltipNoCurrentTask")
					}>
					<PopoverTrigger
						disabled={disabled || !canChangeMode}
						data-testid="auto-approve-dropdown-trigger"
						className={cn("composer-control composer-selector", "max-[300px]:shrink-0", triggerClassName)}>
						<span className="truncate min-w-0">{t(`chat:autoApprove.modes.${mode}`)}</span>
						<ChevronDown className="size-3 shrink-0" aria-hidden="true" />
					</PopoverTrigger>
				</StandardTooltip>
				<PopoverContent
					align="start"
					sideOffset={4}
					container={portalContainer}
					className="p-0 overflow-hidden w-[min(320px,calc(100vw-2rem))]"
					onOpenAutoFocus={(e) => e.preventDefault()}>
					<div className="flex flex-col w-full">
						<div className="p-3 border-b border-vscode-dropdown-border">
							<div className="flex items-center justify-between gap-1 pr-1 pb-2">
								<h4 className="m-0 font-bold text-base text-vscode-foreground">
									{t("chat:autoApprove.title")}
								</h4>
								<Settings
									className="inline mb-0.5 mr-1 size-4 cursor-pointer"
									onClick={handleOpenSettings}
								/>
							</div>
							<p className="m-0 text-xs text-vscode-descriptionForeground">
								{t(isDraft ? "chat:autoApprove.descriptionDraft" : "chat:autoApprove.description")}
							</p>
						</div>
						<div className="flex flex-col gap-1 p-3">
							{isUpdatingCurrentTask && (
								<p className="m-0 text-xs text-vscode-descriptionForeground" role="status">
									{t("chat:autoApprove.updatingTask")}
								</p>
							)}
							{failureForCurrentTask && (
								<p className="m-0 text-xs text-vscode-errorForeground" role="alert">
									{t(
										failureForCurrentTask === "targetUnavailable"
											? "chat:autoApprove.updateTargetUnavailable"
											: failureForCurrentTask === "timedOut"
												? "chat:autoApprove.updateTimedOut"
												: "chat:autoApprove.updateRejected",
									)}
								</p>
							)}
							{MODES.map((candidate) => (
								<StandardTooltip
									key={candidate}
									content={t(`chat:autoApprove.modeDescription.${candidate}`)}>
									<Button
										variant={mode === candidate ? "primary" : "secondary"}
										onClick={() => selectMode(candidate)}
										disabled={disabled || !canChangeMode || isUpdatingCurrentTask}
										aria-pressed={mode === candidate}
										data-testid={`approval-mode-${candidate}`}
										className="justify-start h-auto px-2 py-2 text-sm">
										<span className="font-bold">{t(`chat:autoApprove.modes.${candidate}`)}</span>
									</Button>
								</StandardTooltip>
							))}
						</div>
					</div>
				</PopoverContent>
			</Popover>
			<AlertDialog open={bypassWarningOpen} onOpenChange={setBypassWarningOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("chat:autoApprove.bypassWarning.title")}</AlertDialogTitle>
						<AlertDialogDescription>{t("chat:autoApprove.bypassWarning.body")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("chat:autoApprove.bypassWarning.cancel")}</AlertDialogCancel>
						<AlertDialogAction
							data-testid="approval-mode-bypass-confirm"
							onClick={() => {
								applyMode("bypass")
							}}>
							{t("chat:autoApprove.bypassWarning.confirm")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</>
	)
}
