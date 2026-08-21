import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
	ExternalLink,
	FileDiff,
	LoaderCircle,
	MessageSquareText,
	MoreHorizontal,
	ShieldAlert,
	Square,
	Trash2,
} from "lucide-react"

import type {
	ExtensionMessage,
	ParentVerificationStatus,
	SubagentChangeSetAction,
	SubagentChangeSetActionCapability,
	SubagentChangeSetActionResult,
	SubagentGroupState,
	SubagentRunState,
} from "@alpha-code/types"

import { SubagentTaskLink } from "@/components/agents/SubagentTaskLink"
import { cn } from "@src/lib/utils"
import { vscode } from "@src/utils/vscode"

import {
	Button,
	Dialog,
	DialogClose,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
	Textarea,
} from "../ui"

const activeStatuses = new Set(["pending", "running", "cancelling"])
const MAX_STEERING_MESSAGE_LENGTH = 2_000
let changeSetRequestSequence = 0
const capabilityRefreshMessageTypes = new Set<ExtensionMessage["type"]>([
	"state",
	"messageUpdated",
	"taskHistoryItemUpdated",
	"interactionRequired",
])
const parentVerificationCopy: Record<
	Extract<ParentVerificationStatus, "required" | "pending" | "failed" | "satisfied">,
	{ label: string; nextAction: string }
> = {
	required: {
		label: "Review changes",
		nextAction: "Review the Worker diff, then apply or discard it.",
	},
	pending: {
		label: "Verification pending",
		nextAction: "Run a parent verification command that names at least one applied file.",
	},
	failed: {
		label: "Verification failed",
		nextAction: "Fix the issue, then rerun a parent verification command that names an applied file.",
	},
	satisfied: {
		label: "Verified",
		nextAction: "Parent verification passed.",
	},
}

const compactAttention = (agent: SubagentRunState): string | undefined => {
	if (agent.pendingApproval) return "Approval"
	if (agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)) return "Review"
	if (agent.parentVerification?.status === "failed") return "Fix"
	if (agent.parentVerification?.status === "pending") return "Verify"
	return undefined
}

const getChangeSetActionCapability = (
	capability: SubagentChangeSetActionCapability | undefined,
	action: SubagentChangeSetAction,
) => capability?.actions?.[action] ?? capability

const agentDetail = (agent: SubagentRunState): string => {
	const verification = agent.parentVerification
		? parentVerificationCopy[agent.parentVerification.status as keyof typeof parentVerificationCopy]
		: undefined
	return [agent.role, agent.objective, verification?.nextAction].filter(Boolean).join(" · ")
}

export interface SubagentGroupCardProps {
	group: SubagentGroupState
	parentTaskId?: string
}

export const SubagentGroupCard = memo(({ group, parentTaskId }: SubagentGroupCardProps) => {
	const isActive = activeStatuses.has(group.status)
	const [steeringTaskId, setSteeringTaskId] = useState<string>()
	const [steeringText, setSteeringText] = useState("")
	const [approvalTaskId, setApprovalTaskId] = useState<string>()
	const [cancelRequestedTaskIds, setCancelRequestedTaskIds] = useState<Set<string>>(() => new Set())
	const [changeSetCapabilities, setChangeSetCapabilities] = useState<
		Record<string, SubagentChangeSetActionCapability>
	>({})
	const [pendingChangeSetActions, setPendingChangeSetActions] = useState<
		Record<string, { action: SubagentChangeSetAction; requestId: string }>
	>({})
	const pendingChangeSetActionsRef = useRef(pendingChangeSetActions)
	const [changeSetActionResults, setChangeSetActionResults] = useState<Record<string, SubagentChangeSetActionResult>>(
		{},
	)
	const [changeSetConfirmation, setChangeSetConfirmation] = useState<{
		action: SubagentChangeSetAction
		changeSetId: string
	}>()
	const actionTriggerRef = useRef<HTMLButtonElement | null>(null)
	const resolvedParentTaskId = parentTaskId ?? group.parentTaskId
	const steeringAgent = steeringTaskId
		? group.agents.find((agent) => agent.taskId === steeringTaskId && agent.status === "running")
		: undefined
	const approvalAgent = approvalTaskId
		? group.agents.find((agent) => agent.taskId === approvalTaskId && agent.pendingApproval)
		: undefined
	const actionableChangeSetIds = useMemo(
		() =>
			group.agents
				.flatMap((agent) =>
					agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)
						? [agent.changeSet.id]
						: [],
				)
				.sort(),
		[group.agents],
	)

	useEffect(() => {
		if (steeringTaskId && !steeringAgent) {
			setSteeringTaskId(undefined)
			setSteeringText("")
		}
	}, [steeringAgent, steeringTaskId])

	useEffect(() => {
		if (approvalTaskId && !approvalAgent) setApprovalTaskId(undefined)
	}, [approvalAgent, approvalTaskId])

	useEffect(() => {
		setCancelRequestedTaskIds((current) => {
			const activeTaskIds = new Set(
				group.agents.filter((agent) => activeStatuses.has(agent.status)).map((agent) => agent.taskId),
			)
			const next = new Set([...current].filter((taskId) => activeTaskIds.has(taskId)))
			return next.size === current.size ? current : next
		})
	}, [group.agents])

	const requestChangeSetCapability = useCallback(
		(changeSetId: string) => {
			if (!resolvedParentTaskId) return
			vscode.postMessage({
				type: "requestSubagentChangeSetActionCapability",
				taskId: resolvedParentTaskId,
				groupId: group.groupId,
				changeSetId,
				requestId: `capability:${changeSetId}:${++changeSetRequestSequence}`,
			})
		},
		[group.groupId, resolvedParentTaskId],
	)

	useEffect(() => {
		if (!resolvedParentTaskId || actionableChangeSetIds.length === 0) return

		const requestAll = () => actionableChangeSetIds.forEach(requestChangeSetCapability)
		requestAll()
		let refreshTimer: number | undefined
		const handleMessage = (event: MessageEvent) => {
			if (typeof event.data !== "object" || event.data === null) return
			const message = event.data as ExtensionMessage
			if (message.type === "subagentChangeSetActionCapability") {
				const capability = message.subagentChangeSetActionCapability
				if (
					capability?.taskId === resolvedParentTaskId &&
					capability.groupId === group.groupId &&
					actionableChangeSetIds.includes(capability.changeSetId)
				) {
					setChangeSetCapabilities((current) => ({
						...current,
						[capability.changeSetId]: capability,
					}))
				}
				return
			}

			if (message.type === "subagentChangeSetActionResult") {
				const result = message.subagentChangeSetActionResult
				if (
					result?.taskId !== resolvedParentTaskId ||
					result.groupId !== group.groupId ||
					!actionableChangeSetIds.includes(result.changeSetId)
				) {
					return
				}
				const pending = pendingChangeSetActionsRef.current[result.changeSetId]
				if (message.requestId && pending?.requestId !== message.requestId) return
				const nextPending = { ...pendingChangeSetActionsRef.current }
				delete nextPending[result.changeSetId]
				pendingChangeSetActionsRef.current = nextPending
				setPendingChangeSetActions(nextPending)
				setChangeSetActionResults((current) => ({ ...current, [result.changeSetId]: result }))
				const resultCapability = result.capability
				if (resultCapability) {
					setChangeSetCapabilities((current) => ({
						...current,
						[result.changeSetId]: resultCapability,
					}))
				}
				return
			}

			if (capabilityRefreshMessageTypes.has(message.type)) {
				if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
				refreshTimer = window.setTimeout(requestAll, 75)
			}
		}

		window.addEventListener("message", handleMessage)
		return () => {
			window.removeEventListener("message", handleMessage)
			if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
		}
	}, [actionableChangeSetIds, group.groupId, requestChangeSetCapability, resolvedParentTaskId])

	const openTask = (agent: SubagentRunState) => vscode.postMessage({ type: "showTaskWithId", text: agent.taskId })
	const openChangeSet = (changeSetId: string) =>
		vscode.postMessage({
			type: "openSubagentChangeSet",
			taskId: resolvedParentTaskId,
			groupId: group.groupId,
			changeSetId,
		})
	const submitChangeSetAction = (action: SubagentChangeSetAction, changeSetId: string) => {
		const capability = getChangeSetActionCapability(changeSetCapabilities[changeSetId], action)
		if (!resolvedParentTaskId || !capability?.allowed || pendingChangeSetActions[changeSetId]) return
		setChangeSetConfirmation({ action, changeSetId })
	}
	const confirmChangeSetAction = () => {
		if (!resolvedParentTaskId || !changeSetConfirmation) return
		const { action, changeSetId } = changeSetConfirmation
		const capability = getChangeSetActionCapability(changeSetCapabilities[changeSetId], action)
		const agent = group.agents.find(
			(candidate) =>
				candidate.changeSet?.id === changeSetId &&
				["pending_review", "conflicted"].includes(candidate.changeSet.status),
		)
		if (!agent || !capability?.allowed || pendingChangeSetActionsRef.current[changeSetId]) return

		const requestId = `${action}:${changeSetId}:${++changeSetRequestSequence}`
		const nextPending = {
			...pendingChangeSetActionsRef.current,
			[changeSetId]: { action, requestId },
		}
		pendingChangeSetActionsRef.current = nextPending
		setPendingChangeSetActions(nextPending)
		setChangeSetActionResults((current) => {
			const next = { ...current }
			delete next[changeSetId]
			return next
		})
		vscode.postMessage({
			type: action === "apply" ? "applySubagentChangeSet" : "discardSubagentChangeSet",
			taskId: resolvedParentTaskId,
			groupId: group.groupId,
			changeSetId,
			requestId,
		})
		setChangeSetConfirmation(undefined)
	}
	const closeSteeringDialog = () => {
		setSteeringTaskId(undefined)
		setSteeringText("")
	}
	const submitSteering = () => {
		const text = steeringText.trim().slice(0, MAX_STEERING_MESSAGE_LENGTH)
		if (!steeringAgent || steeringAgent.status !== "running" || !text) return
		vscode.postMessage({
			type: "steerSubagent",
			taskId: resolvedParentTaskId,
			groupId: group.groupId,
			subagentTaskId: steeringAgent.taskId,
			text,
		})
		closeSteeringDialog()
	}
	const cancelAgent = (agent: SubagentRunState) => {
		if (!activeStatuses.has(agent.status) || cancelRequestedTaskIds.has(agent.taskId)) return
		setCancelRequestedTaskIds((current) => new Set(current).add(agent.taskId))
		vscode.postMessage({
			type: "cancelSubagent",
			taskId: resolvedParentTaskId,
			groupId: group.groupId,
			subagentTaskId: agent.taskId,
		})
	}
	const respondToApproval = (approved: boolean) => {
		if (!approvalAgent?.pendingApproval) return
		vscode.postMessage({
			type: "respondToSubagentApproval",
			taskId: resolvedParentTaskId,
			groupId: group.groupId,
			subagentTaskId: approvalAgent.taskId,
			approvalId: approvalAgent.pendingApproval.id,
			approved,
		})
		setApprovalTaskId(undefined)
	}
	const changeSetConfirmationAgent = changeSetConfirmation
		? group.agents.find(
				(agent) =>
					agent.changeSet?.id === changeSetConfirmation.changeSetId &&
					["pending_review", "conflicted"].includes(agent.changeSet.status),
			)
		: undefined
	const changeSetConfirmationCapability = changeSetConfirmation
		? getChangeSetActionCapability(
				changeSetCapabilities[changeSetConfirmation.changeSetId],
				changeSetConfirmation.action,
			)
		: undefined
	const canConfirmChangeSetAction = Boolean(
		changeSetConfirmationAgent &&
			changeSetConfirmationCapability?.allowed &&
			changeSetConfirmation &&
			!pendingChangeSetActions[changeSetConfirmation.changeSetId],
	)
	const isApplyConfirmation = changeSetConfirmation?.action === "apply"

	return (
		<>
			<section
				aria-label={`${group.agents.length} sub-agent task${group.agents.length === 1 ? "" : "s"}`}
				className="rounded-lg border border-[var(--border-subtle)] bg-vscode-editor-background/40 p-1">
				<div className="flex min-w-0 items-start gap-1">
					<div className="min-w-0 flex-1 space-y-0.5">
						{group.agents.map((agent, agentIndex) => {
							const cancelRequested =
								agent.status === "cancelling" || cancelRequestedTaskIds.has(agent.taskId)
							const canMutateChangeSet =
								agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)
							const capability = agent.changeSet ? changeSetCapabilities[agent.changeSet.id] : undefined
							const applyCapability = getChangeSetActionCapability(capability, "apply")
							const discardCapability = getChangeSetActionCapability(capability, "discard")
							const capabilityMessage = !applyCapability?.allowed
								? `${discardCapability?.allowed ? "Apply unavailable: " : ""}${applyCapability?.reason ?? "Checking whether the parent is paused…"}`
								: !discardCapability?.allowed
									? `Discard unavailable: ${discardCapability?.reason ?? "Checking whether the parent is paused…"}`
									: undefined
							const pendingAction = agent.changeSet
								? pendingChangeSetActions[agent.changeSet.id]
								: undefined
							const verificationCopy =
								agent.parentVerification &&
								["required", "pending", "failed", "satisfied"].includes(agent.parentVerification.status)
									? parentVerificationCopy[
											agent.parentVerification.status as keyof typeof parentVerificationCopy
										]
									: undefined
							const taskUnavailable = agent.stopReason === "never_launched"
							const hasChangeSetActions =
								agent.changeSet && !["unavailable", "scope_violation"].includes(agent.changeSet.status)
							const hasGroupStopAction = isActive && group.agents.length > 1 && agentIndex === 0
							const hasOverflowActions =
								!taskUnavailable ||
								Boolean(agent.pendingApproval) ||
								agent.status === "running" ||
								activeStatuses.has(agent.status) ||
								Boolean(hasChangeSetActions) ||
								Boolean(verificationCopy) ||
								hasGroupStopAction

							return (
								<div key={agent.taskId} className="min-w-0">
									<div className="flex min-w-0 items-center gap-0.5">
										<SubagentTaskLink
											name={agent.nickname}
											status={agent.status}
											attention={compactAttention(agent)}
											detail={taskUnavailable ? agent.error : agentDetail(agent)}
											disabled={taskUnavailable}
											onOpen={() => openTask(agent)}
										/>
										{hasOverflowActions && (
											<DropdownMenu>
												<DropdownMenuTrigger asChild>
													<button
														type="button"
														aria-label={`Actions for ${agent.nickname}`}
														onClick={(event) => {
															actionTriggerRef.current = event.currentTarget
														}}
														className="inline-flex size-8 shrink-0 items-center justify-center rounded-md border-0 bg-transparent text-vscode-descriptionForeground hover:bg-[var(--alpha-accent-soft)] hover:text-vscode-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder">
														<MoreHorizontal className="size-4" aria-hidden="true" />
													</button>
												</DropdownMenuTrigger>
												<DropdownMenuContent align="end" className="w-64">
													{!taskUnavailable && (
														<DropdownMenuItem onSelect={() => openTask(agent)}>
															<ExternalLink aria-hidden="true" /> Open task
														</DropdownMenuItem>
													)}
													{agent.pendingApproval && (
														<DropdownMenuItem
															onSelect={() => setApprovalTaskId(agent.taskId)}>
															<ShieldAlert aria-hidden="true" /> Review request
														</DropdownMenuItem>
													)}
													{agent.status === "running" && (
														<DropdownMenuItem
															onSelect={() => {
																setSteeringText("")
																setSteeringTaskId(agent.taskId)
															}}>
															<MessageSquareText aria-hidden="true" /> Steer
														</DropdownMenuItem>
													)}
													{activeStatuses.has(agent.status) && (
														<DropdownMenuItem
															disabled={cancelRequested}
															onSelect={() => cancelAgent(agent)}>
															{cancelRequested ? (
																<LoaderCircle
																	className="animate-spin"
																	aria-hidden="true"
																/>
															) : (
																<Square aria-hidden="true" />
															)}
															{cancelRequested ? "Stopping…" : "Stop"}
														</DropdownMenuItem>
													)}
													{agent.changeSet &&
														!["unavailable", "scope_violation"].includes(
															agent.changeSet.status,
														) && (
															<>
																<DropdownMenuSeparator />
																<DropdownMenuItem
																	onSelect={() => openChangeSet(agent.changeSet!.id)}>
																	<FileDiff aria-hidden="true" /> Open diff
																</DropdownMenuItem>
																{canMutateChangeSet && (
																	<>
																		<DropdownMenuItem
																			disabled={
																				!applyCapability?.allowed ||
																				Boolean(pendingAction)
																			}
																			title={
																				applyCapability?.allowed
																					? undefined
																					: applyCapability?.reason
																			}
																			onSelect={() =>
																				submitChangeSetAction(
																					"apply",
																					agent.changeSet!.id,
																				)
																			}>
																			<FileDiff aria-hidden="true" />
																			{pendingAction?.action === "apply"
																				? "Applying…"
																				: "Apply changes"}
																		</DropdownMenuItem>
																		<DropdownMenuItem
																			disabled={
																				!discardCapability?.allowed ||
																				Boolean(pendingAction)
																			}
																			title={
																				discardCapability?.allowed
																					? undefined
																					: discardCapability?.reason
																			}
																			onSelect={() =>
																				submitChangeSetAction(
																					"discard",
																					agent.changeSet!.id,
																				)
																			}
																			className="text-vscode-errorForeground">
																			<Trash2 aria-hidden="true" />
																			{pendingAction?.action === "discard"
																				? "Discarding…"
																				: "Discard"}
																		</DropdownMenuItem>
																	</>
																)}
																{canMutateChangeSet && capabilityMessage && (
																	<DropdownMenuLabel className="whitespace-normal text-xs font-normal text-vscode-descriptionForeground">
																		{capabilityMessage}
																	</DropdownMenuLabel>
																)}
															</>
														)}
													{verificationCopy && (
														<>
															<DropdownMenuSeparator />
															<DropdownMenuLabel className="whitespace-normal text-xs font-normal text-vscode-descriptionForeground">
																<span className="font-medium text-vscode-foreground">
																	{verificationCopy.label}
																</span>
																<br />
																{verificationCopy.nextAction}
															</DropdownMenuLabel>
														</>
													)}
													{isActive && group.agents.length > 1 && agentIndex === 0 && (
														<>
															<DropdownMenuSeparator />
															<DropdownMenuItem
																onSelect={() =>
																	vscode.postMessage({
																		type: "cancelSubagentGroup",
																		taskId: resolvedParentTaskId,
																		groupId: group.groupId,
																	})
																}>
																<Square aria-hidden="true" /> Stop all
															</DropdownMenuItem>
														</>
													)}
												</DropdownMenuContent>
											</DropdownMenu>
										)}
									</div>
									{taskUnavailable && agent.error && (
										<p
											className="px-2 pb-1 text-[11px] leading-4 text-vscode-descriptionForeground"
											role="status">
											{agent.error}
										</p>
									)}
								</div>
							)
						})}
					</div>
				</div>
				{Object.values(changeSetActionResults).map((result) => (
					<div
						key={result.changeSetId}
						className={cn(
							"px-2 py-1 text-[11px]",
							result.success ? "text-vscode-descriptionForeground" : "text-vscode-errorForeground",
						)}
						role={result.success ? "status" : "alert"}>
						{result.message}
					</div>
				))}
			</section>

			<Dialog
				open={Boolean(changeSetConfirmation)}
				onOpenChange={(open) => {
					if (!open) setChangeSetConfirmation(undefined)
				}}>
				<DialogContent
					className="max-w-md gap-4 p-5"
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						actionTriggerRef.current?.focus()
					}}>
					<DialogHeader>
						<DialogTitle>
							{isApplyConfirmation ? "Apply Worker changes?" : "Discard Worker changes?"}
						</DialogTitle>
						<DialogDescription>
							{isApplyConfirmation
								? `Apply ${changeSetConfirmationAgent?.nickname ?? "this Worker"}'s reviewed changes to the parent working tree. This will not stage or commit anything.`
								: `Permanently discard ${changeSetConfirmationAgent?.nickname ?? "this Worker"}'s quarantined proposal without changing the parent working tree.`}
							{changeSetConfirmation && !canConfirmChangeSetAction && (
								<span className="mt-2 block text-vscode-editorWarning-foreground" role="status">
									{changeSetConfirmationAgent
										? (changeSetConfirmationCapability?.reason ??
											"Checking whether the parent is paused…")
										: "This change set is no longer available for review."}
								</span>
							)}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="secondary">
								Cancel
							</Button>
						</DialogClose>
						<Button
							type="button"
							variant="primary"
							disabled={!canConfirmChangeSetAction}
							onClick={confirmChangeSetAction}>
							{isApplyConfirmation ? "Confirm apply" : "Confirm discard"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={Boolean(approvalAgent)}
				onOpenChange={(open) => {
					if (!open) setApprovalTaskId(undefined)
				}}>
				<DialogContent
					className="max-w-md gap-4 p-5"
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						actionTriggerRef.current?.focus()
					}}>
					<DialogHeader>
						<DialogTitle>Review {approvalAgent?.nickname}&apos;s request</DialogTitle>
						<DialogDescription>
							The sub-agent is paused until this operation is approved or denied.
						</DialogDescription>
					</DialogHeader>
					<div className="rounded-lg border border-[var(--border-subtle)] bg-[var(--surface-sunken)] p-3 text-sm">
						<div className="break-words font-medium">{approvalAgent?.pendingApproval?.operation}</div>
						{approvalAgent?.pendingApproval?.scope && (
							<div className="mt-1 break-words text-xs text-vscode-descriptionForeground">
								Scope: {approvalAgent.pendingApproval.scope}
							</div>
						)}
					</div>
					<DialogFooter>
						<Button type="button" variant="secondary" onClick={() => respondToApproval(false)}>
							Deny
						</Button>
						<Button type="button" variant="primary" onClick={() => respondToApproval(true)}>
							Approve
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={Boolean(steeringAgent)}
				onOpenChange={(open) => {
					if (!open) closeSteeringDialog()
				}}>
				<DialogContent
					className="max-w-md gap-4 p-5"
					onCloseAutoFocus={(event) => {
						event.preventDefault()
						actionTriggerRef.current?.focus()
					}}>
					<DialogHeader>
						<DialogTitle>Steer {steeringAgent?.nickname}</DialogTitle>
						<DialogDescription>
							Send a concise correction or additional context. Authority and write scope do not change.
						</DialogDescription>
					</DialogHeader>
					<form
						className="space-y-4"
						onSubmit={(event) => {
							event.preventDefault()
							submitSteering()
						}}>
						<label htmlFor={`subagent-steering-${steeringAgent?.taskId}`} className="sr-only">
							Steering instruction for {steeringAgent?.nickname}
						</label>
						<Textarea
							id={`subagent-steering-${steeringAgent?.taskId}`}
							autoFocus
							maxLength={MAX_STEERING_MESSAGE_LENGTH}
							rows={5}
							value={steeringText}
							onChange={(event) => setSteeringText(event.target.value)}
							placeholder="What should this sub-agent adjust?"
						/>
						<div className="text-right text-xs text-vscode-descriptionForeground" aria-live="off">
							{steeringText.length}/{MAX_STEERING_MESSAGE_LENGTH}
						</div>
						<DialogFooter>
							<DialogClose asChild>
								<Button type="button" variant="secondary">
									Cancel
								</Button>
							</DialogClose>
							<Button type="submit" variant="primary" disabled={!steeringText.trim()}>
								Send steering
							</Button>
						</DialogFooter>
					</form>
				</DialogContent>
			</Dialog>
		</>
	)
})

SubagentGroupCard.displayName = "SubagentGroupCard"
