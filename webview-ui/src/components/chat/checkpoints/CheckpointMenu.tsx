import { useState, useCallback, useEffect, useId, useLayoutEffect, useRef } from "react"
import { CheckIcon, Cross2Icon } from "@radix-ui/react-icons"
import { useTranslation } from "react-i18next"

import { Button, Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAlphaPortal } from "@/components/ui/hooks"
import { useShellState } from "@/context/ExtensionStateContext"

import { vscode } from "@src/utils/vscode"
import { Checkpoint } from "./schema"

type CheckpointMenuBaseProps = {
	ts: number
	commitHash: string
	checkpoint: Checkpoint
	onJumpToPreviousCheckpoint?: () => void
}
type CheckpointMenuControlledProps = {
	onOpenChange: (open: boolean) => void
}
type CheckpointMenuUncontrolledProps = {
	onOpenChange?: undefined
}
type CheckpointMenuProps = CheckpointMenuBaseProps & (CheckpointMenuControlledProps | CheckpointMenuUncontrolledProps)

type RestoreConfirmation = {
	taskId: string
	ts: number
	commitHash: string
	mode: "preview" | "restore"
}

export const CheckpointMenu = ({
	ts,
	commitHash,
	checkpoint,
	onOpenChange,
	onJumpToPreviousCheckpoint,
}: CheckpointMenuProps) => {
	const { t } = useTranslation()
	const [internalRestoreOpen, setInternalRestoreOpen] = useState(false)
	const [pendingRestore, setPendingRestore] = useState<RestoreConfirmation>()
	const [internalMoreOpen, setInternalMoreOpen] = useState(false)
	const fileRestoreActionRef = useRef<HTMLButtonElement>(null)
	const taskRestoreActionRef = useRef<HTMLButtonElement>(null)
	const cancelledRestoreFocus = useRef<RestoreConfirmation>()
	const restoreWarningId = useId()
	const portalContainer = useAlphaPortal("alpha-portal")
	const { currentTaskId } = useShellState()
	const restoreConfirmation =
		pendingRestore?.taskId === currentTaskId &&
		pendingRestore?.ts === ts &&
		pendingRestore?.commitHash === commitHash
			? pendingRestore
			: undefined
	useEffect(() => setPendingRestore(undefined), [currentTaskId, ts, commitHash])
	useLayoutEffect(() => {
		const cancelled = cancelledRestoreFocus.current
		if (!cancelled) return
		cancelledRestoreFocus.current = undefined
		if (
			!internalRestoreOpen ||
			restoreConfirmation ||
			cancelled.taskId !== currentTaskId ||
			cancelled.ts !== ts ||
			cancelled.commitHash !== commitHash
		) {
			return
		}
		const actionRef = cancelled.mode === "preview" ? fileRestoreActionRef : taskRestoreActionRef
		actionRef.current?.focus()
	}, [internalRestoreOpen, restoreConfirmation, currentTaskId, ts, commitHash])

	const previousCommitHash = checkpoint?.from

	const restoreOpen = internalRestoreOpen
	const moreOpen = internalMoreOpen
	const setRestoreOpen = useCallback(
		(open: boolean) => {
			setInternalRestoreOpen(open)
			setPendingRestore(undefined)
			cancelledRestoreFocus.current = undefined
			if (onOpenChange) {
				onOpenChange(open)
			}
		},
		[onOpenChange],
	)

	const setMoreOpen = useCallback(
		(open: boolean) => {
			setInternalMoreOpen(open)
			if (onOpenChange) {
				onOpenChange(open)
			}
		},
		[onOpenChange],
	)

	const onCheckpointDiff = useCallback(() => {
		vscode.postMessage({
			type: "checkpointDiff",
			taskId: currentTaskId,
			payload: { ts, previousCommitHash, commitHash, mode: "checkpoint" },
		})
	}, [ts, previousCommitHash, commitHash, currentTaskId])

	const onDiffFromInit = useCallback(() => {
		vscode.postMessage({
			type: "checkpointDiff",
			taskId: currentTaskId,
			payload: { ts, commitHash, mode: "from-init" },
		})
	}, [ts, commitHash, currentTaskId])

	const onDiffWithCurrent = useCallback(() => {
		vscode.postMessage({
			type: "checkpointDiff",
			taskId: currentTaskId,
			payload: { ts, commitHash, mode: "to-current" },
		})
	}, [ts, commitHash, currentTaskId])

	const onRestore = useCallback(() => {
		if (!restoreConfirmation) return
		const { taskId, ts, commitHash, mode } = restoreConfirmation
		vscode.postMessage({
			type: "checkpointRestore",
			taskId,
			payload: { ts, commitHash, mode },
		})
		setRestoreOpen(false)
	}, [restoreConfirmation, setRestoreOpen])

	const requestRestore = useCallback(
		(mode: RestoreConfirmation["mode"]) => {
			if (!currentTaskId) return
			setPendingRestore({ taskId: currentTaskId, ts, commitHash, mode })
		},
		[currentTaskId, ts, commitHash],
	)
	const cancelRestore = useCallback(() => {
		if (!restoreConfirmation) return
		cancelledRestoreFocus.current = restoreConfirmation
		setPendingRestore(undefined)
	}, [restoreConfirmation])

	return (
		<div className="flex flex-row gap-1">
			<StandardTooltip content={t("chat:checkpoint.menu.viewDiff")}>
				<Button
					variant="ghost"
					size="icon"
					onClick={onCheckpointDiff}
					aria-label={t("chat:checkpoint.menu.viewDiff")}>
					<span className="codicon codicon-diff-single" />
				</Button>
			</StandardTooltip>
			<Popover open={restoreOpen} onOpenChange={setRestoreOpen} data-testid="restore-popover">
				<StandardTooltip content={t("chat:checkpoint.menu.restore")}>
					<PopoverTrigger asChild>
						<Button variant="ghost" size="icon" aria-label={t("chat:checkpoint.menu.restore")}>
							<span className="codicon codicon-history" />
						</Button>
					</PopoverTrigger>
				</StandardTooltip>
				<PopoverContent align="end" container={portalContainer}>
					<div className="flex flex-col gap-2">
						{!restoreConfirmation ? (
							<>
								<div className="flex flex-col gap-1 group hover:text-foreground">
									<Button
										ref={fileRestoreActionRef}
										variant="secondary"
										onClick={() => requestRestore("preview")}
										disabled={!currentTaskId}
										data-testid="restore-files-btn">
										{t("chat:checkpoint.menu.restoreFiles")}
									</Button>
									<div className="text-muted transition-colors group-hover:text-foreground">
										{t("chat:checkpoint.menu.restoreFilesDescription")}
									</div>
								</div>
								<div className="flex flex-col gap-1 group hover:text-foreground">
									<Button
										ref={taskRestoreActionRef}
										variant="secondary"
										onClick={() => requestRestore("restore")}
										disabled={!currentTaskId}
										data-testid="restore-files-and-task-btn">
										{t("chat:checkpoint.menu.restoreFilesAndTask")}
									</Button>
									<div className="text-muted transition-colors group-hover:text-foreground">
										{t("chat:checkpoint.menu.restoreFilesAndTaskDescription")}
									</div>
								</div>
							</>
						) : (
							<>
								<div className="font-medium">
									{t(
										restoreConfirmation.mode === "preview"
											? "chat:checkpoint.menu.restoreFiles"
											: "chat:checkpoint.menu.restoreFilesAndTask",
									)}
								</div>
								<div
									id={restoreWarningId}
									role="alert"
									data-testid="checkpoint-confirm-warning"
									className="flex flex-col gap-1 text-vscode-foreground">
									<span>{t("chat:checkpoint.menu.restoreWorkspaceWarning")}</span>
									<span className="text-destructive font-bold">
										{t("chat:checkpoint.menu.cannotUndo")}
									</span>
								</div>
								<Button
									variant="primary"
									onClick={onRestore}
									aria-describedby={restoreWarningId}
									className="grow"
									data-testid="confirm-restore-btn">
									<div className="flex flex-row gap-1">
										<CheckIcon />
										<div>{t("chat:checkpoint.menu.confirm")}</div>
									</div>
								</Button>
								<Button variant="secondary" autoFocus onClick={cancelRestore}>
									<div className="flex flex-row gap-1">
										<Cross2Icon />
										<div>{t("chat:checkpoint.menu.cancel")}</div>
									</div>
								</Button>
							</>
						)}
					</div>
				</PopoverContent>
			</Popover>
			<StandardTooltip content={t("chat:scrollToLatestCheckpoint")}>
				<Button
					variant="ghost"
					size="icon"
					onClick={onJumpToPreviousCheckpoint}
					data-testid="jump-previous-checkpoint-btn"
					aria-label={t("chat:scrollToLatestCheckpoint")}>
					<span className="codicon codicon-chevron-up" />
				</Button>
			</StandardTooltip>
			<Popover open={moreOpen} onOpenChange={(open) => setMoreOpen(open)} data-testid="more-popover">
				<StandardTooltip content={t("chat:task.seeMore")}>
					<PopoverTrigger asChild>
						<Button variant="ghost" size="icon" aria-label={t("chat:checkpoint.menu.more")}>
							<span className="codicon codicon-kebab-vertical" />
						</Button>
					</PopoverTrigger>
				</StandardTooltip>
				<PopoverContent align="end" container={portalContainer} className="w-auto min-w-max">
					<div className="flex flex-col gap-2">
						<Button
							variant="secondary"
							onClick={() => {
								onDiffFromInit()
								setMoreOpen(false)
							}}>
							<span className="codicon codicon-versions mr-2" />
							{t("chat:checkpoint.menu.viewDiffFromInit")}
						</Button>
						<Button
							variant="secondary"
							onClick={() => {
								onDiffWithCurrent()
								setMoreOpen(false)
							}}>
							<span className="codicon codicon-diff mr-2" />
							{t("chat:checkpoint.menu.viewDiffWithCurrent")}
						</Button>
					</div>
				</PopoverContent>
			</Popover>
		</div>
	)
}
