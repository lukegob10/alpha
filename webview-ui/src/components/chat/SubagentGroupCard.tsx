import { memo, useCallback, useEffect, useMemo, useState } from "react"
import {
	Ban,
	CheckCircle2,
	ChevronDown,
	ChevronRight,
	CircleAlert,
	Clock3,
	ExternalLink,
	FileDiff,
	GitFork,
	LoaderCircle,
	MessageSquareText,
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
		label: "Review required",
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
		nextAction: "Parent verification passed; completion is unblocked.",
	},
}
const phaseLabels: Record<NonNullable<SubagentRunState["phase"]>, string> = {
	queued: "Queued",
	starting: "Starting",
	working: "Working",
	waiting: "Configured request delay",
	steering: "Applying steering",
	reporting: "Preparing report",
	finalizing: "Finalizing",
}

const roleLabel = (role: SubagentRunState["role"]) =>
	role === "explore" ? "Explorer" : role === "review" ? "Reviewer" : "Worker"
const agentStatusLabel = (agent: SubagentRunState) =>
	agent.status === "cancelling"
		? "cancelling"
		: activeStatuses.has(agent.status) && agent.phase
			? phaseLabels[agent.phase]
			: agent.status.replace("_", " ")
const formatElapsed = (milliseconds: number) => {
	const seconds = Math.max(0, Math.floor(milliseconds / 1000))
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}
const modelRouteLabel = (agent: SubagentRunState) => {
	const route = agent.modelRoute
	if (!route) return undefined
	const model = [route.provider, route.modelId].filter(Boolean).join(" · ")
	const profile = route.source === "parent" ? `Parent profile: ${route.profileName}` : route.profileName
	return model ? `${profile} · ${model}` : profile
}
const statusIcon = (agent: SubagentRunState) => {
	switch (agent.status) {
		case "pending":
		case "running":
			return agent.phase === "waiting" ? (
				<Clock3 className="size-4 text-vscode-descriptionForeground" />
			) : (
				<LoaderCircle className="size-4 animate-spin text-vscode-progressBar-background" />
			)
		case "cancelling":
			return <LoaderCircle className="size-4 animate-spin text-vscode-descriptionForeground" />
		case "completed":
			return <CheckCircle2 className="size-4 text-vscode-testing-iconPassed" />
		case "blocked":
			return <ShieldAlert className="size-4 text-vscode-editorWarning-foreground" />
		case "timed_out":
			return <Clock3 className="size-4 text-vscode-editorWarning-foreground" />
		case "cancelled":
			return <Ban className="size-4 text-vscode-descriptionForeground" />
		default:
			return <CircleAlert className="size-4 text-vscode-testing-iconFailed" />
	}
}

export interface SubagentGroupCardProps {
	group: SubagentGroupState
	parentTaskId?: string
}

export const SubagentGroupCard = memo(({ group, parentTaskId }: SubagentGroupCardProps) => {
	const isActive = activeStatuses.has(group.status)
	const [expanded, setExpanded] = useState(() => isActive)
	const [now, setNow] = useState(Date.now())
	const [steeringAgent, setSteeringAgent] = useState<SubagentRunState>()
	const [steeringText, setSteeringText] = useState("")
	const [cancelRequestedTaskIds, setCancelRequestedTaskIds] = useState<Set<string>>(() => new Set())
	const [changeSetCapabilities, setChangeSetCapabilities] = useState<
		Record<string, SubagentChangeSetActionCapability>
	>({})
	const [pendingChangeSetActions, setPendingChangeSetActions] = useState<
		Record<string, { action: SubagentChangeSetAction; requestId: string }>
	>({})
	const [changeSetActionResults, setChangeSetActionResults] = useState<Record<string, SubagentChangeSetActionResult>>(
		{},
	)
	const [changeSetConfirmation, setChangeSetConfirmation] = useState<{
		action: SubagentChangeSetAction
		changeSetId: string
	}>()
	const resolvedParentTaskId = parentTaskId ?? group.parentTaskId
	const actionableChangeSetIds = group.agents
		.flatMap((agent) =>
			agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)
				? [agent.changeSet.id]
				: [],
		)
		.sort()
	const actionableChangeSetKey = actionableChangeSetIds.join("|")

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
				setPendingChangeSetActions((current) => {
					const pending = current[result.changeSetId]
					if (message.requestId && pending && pending.requestId !== message.requestId) return current
					const next = { ...current }
					delete next[result.changeSetId]
					return next
				})
				setChangeSetActionResults((current) => ({ ...current, [result.changeSetId]: result }))
				if (result.capability) {
					setChangeSetCapabilities((current) => ({
						...current,
						[result.changeSetId]: result.capability!,
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
		// The joined key intentionally tracks the actionable IDs without making the
		// effect depend on a new array instance on every render.
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [actionableChangeSetKey, group.groupId, requestChangeSetCapability, resolvedParentTaskId])

	useEffect(() => {
		if (!isActive) return
		const timer = window.setInterval(() => setNow(Date.now()), 1_000)
		return () => window.clearInterval(timer)
	}, [isActive])

	const terminalCount = group.agents.filter((agent) => !activeStatuses.has(agent.status)).length
	const elapsed = useMemo(
		() => formatElapsed((group.completedAt ?? now) - (group.startedAt ?? group.createdAt)),
		[group.completedAt, group.createdAt, group.startedAt, now],
	)
	const openChangeSet = (id: string) =>
		vscode.postMessage({
			type: "openSubagentChangeSet",
			taskId: resolvedParentTaskId,
			groupId: group.groupId,
			changeSetId: id,
		})
	const submitChangeSetAction = (action: SubagentChangeSetAction, changeSetId: string) => {
		const capability = changeSetCapabilities[changeSetId]
		if (!resolvedParentTaskId || !capability?.allowed || pendingChangeSetActions[changeSetId]) return
		setChangeSetConfirmation({ action, changeSetId })
	}
	const confirmChangeSetAction = () => {
		if (!resolvedParentTaskId || !changeSetConfirmation) return
		const { action, changeSetId } = changeSetConfirmation
		if (pendingChangeSetActions[changeSetId]) return

		const requestId = `${action}:${changeSetId}:${++changeSetRequestSequence}`
		setPendingChangeSetActions((current) => ({ ...current, [changeSetId]: { action, requestId } }))
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
		setSteeringAgent(undefined)
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
	const changeSetConfirmationAgent = changeSetConfirmation
		? group.agents.find((agent) => agent.changeSet?.id === changeSetConfirmation.changeSetId)
		: undefined
	const isApplyConfirmation = changeSetConfirmation?.action === "apply"
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

	return (
		<>
			<section
				aria-label={`${group.agents.length} sub-agents`}
				className="overflow-hidden rounded-xl border border-vscode-panel-border bg-vscode-editor-background shadow-sm">
				<div className="flex min-h-11 items-center gap-2 px-3 py-2">
					<button
						type="button"
						aria-expanded={expanded}
						aria-label={expanded ? "Collapse sub-agent group" : "Expand sub-agent group"}
						onClick={() => setExpanded((value) => !value)}
						className="flex min-w-0 flex-1 items-center gap-2 border-0 bg-transparent p-0 text-left text-vscode-foreground">
						{expanded ? (
							<ChevronDown className="size-4 shrink-0" />
						) : (
							<ChevronRight className="size-4 shrink-0" />
						)}
						<span className="truncate font-medium">{group.agents.length} sub-agents</span>
						<span
							className="shrink-0 text-xs text-vscode-descriptionForeground"
							role="status"
							aria-live="polite">
							{isActive
								? `${terminalCount}/${group.agents.length} finished`
								: group.status.replace("_", " ")}{" "}
							· {elapsed}
						</span>
					</button>
					{isActive && (
						<button
							type="button"
							aria-label="Cancel sub-agent group"
							onClick={() =>
								vscode.postMessage({
									type: "cancelSubagentGroup",
									taskId: resolvedParentTaskId,
									groupId: group.groupId,
								})
							}
							className="rounded-md border border-vscode-button-border bg-transparent px-2 py-1 text-xs text-vscode-descriptionForeground hover:bg-vscode-toolbar-hoverBackground">
							Cancel
						</button>
					)}
				</div>

				{expanded && (
					<div className="border-t border-vscode-panel-border">
						{group.agents.map((agent) => {
							const terminal = !activeStatuses.has(agent.status)
							const cancelRequested =
								agent.status === "cancelling" || cancelRequestedTaskIds.has(agent.taskId)
							const preview = agent.summary ?? agent.error
							const pacingWait = agent.usage.rateLimitWaitCount
								? `${agent.usage.rateLimitWaitCount} pacing wait${agent.usage.rateLimitWaitCount === 1 ? "" : "s"} · ${formatElapsed(agent.usage.rateLimitWaitMs ?? 0)}`
								: undefined
							const canMutateChangeSet =
								agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)
							const changeSetCapability = agent.changeSet
								? changeSetCapabilities[agent.changeSet.id]
								: undefined
							const pendingChangeSetAction = agent.changeSet
								? pendingChangeSetActions[agent.changeSet.id]
								: undefined
							const changeSetActionResult = agent.changeSet
								? changeSetActionResults[agent.changeSet.id]
								: undefined
							const verificationCopy =
								agent.parentVerification &&
								["required", "pending", "failed", "satisfied"].includes(agent.parentVerification.status)
									? parentVerificationCopy[
											agent.parentVerification.status as keyof typeof parentVerificationCopy
										]
									: undefined
							return (
								<div
									key={agent.taskId}
									className="border-b border-vscode-panel-border/60 px-3 py-2.5 last:border-b-0">
									<div className="flex items-start gap-2">
										<div className="mt-0.5 shrink-0" aria-label={agentStatusLabel(agent)}>
											{statusIcon(agent)}
										</div>
										<div className="min-w-0 flex-1">
											<div className="flex items-center justify-between gap-2">
												<span className="font-medium">
													{agent.nickname} · {roleLabel(agent.role)}
												</span>
												<span className="shrink-0 text-xs capitalize text-vscode-descriptionForeground">
													{agentStatusLabel(agent)}
												</span>
											</div>
											<p
												className="m-0 mt-0.5 truncate text-xs text-vscode-descriptionForeground"
												title={agent.objective}>
												{agent.objective}
											</p>
											{agent.modelRoute && (
												<div
													className={cn(
														"mt-1 flex items-start gap-1 text-xs text-vscode-descriptionForeground",
														agent.modelRoute.resolution === "fallback" &&
															"text-vscode-editorWarning-foreground",
													)}
													role={
														agent.modelRoute.resolution === "fallback"
															? "status"
															: undefined
													}>
													{agent.modelRoute.resolution === "fallback" && (
														<CircleAlert
															className="mt-0.5 size-3 shrink-0"
															aria-hidden="true"
														/>
													)}
													<span>
														{agent.modelRoute.resolution === "fallback" &&
															"Using parent profile · "}
														{modelRouteLabel(agent)}
													</span>
												</div>
											)}
											{agent.role === "worker" && (
												<div className="mt-1.5 space-y-1 text-xs text-vscode-descriptionForeground">
													<div className="inline-flex items-center gap-1 rounded-full border border-vscode-panel-border px-2 py-0.5">
														<GitFork className="size-3" /> Isolated worktree
													</div>
													{agent.writeScope && (
														<div title={agent.writeScope.join(", ")}>
															Write scope: {agent.writeScope.join(", ")}
														</div>
													)}
												</div>
											)}
											{agent.pendingApproval && (
												<div className="mt-2 rounded-lg border border-vscode-editorWarning-foreground/50 p-2 text-xs">
													<div className="flex items-center gap-1 font-medium">
														<ShieldAlert className="size-3.5" /> {agent.nickname} requests
														approval
													</div>
													<div className="mt-1 break-words">
														{agent.pendingApproval.operation}
													</div>
													{agent.pendingApproval.scope && (
														<div className="mt-1">Scope: {agent.pendingApproval.scope}</div>
													)}
													<div className="mt-2 flex gap-2">
														{[true, false].map((approved) => (
															<button
																key={String(approved)}
																type="button"
																aria-label={`${approved ? "Approve" : "Deny"} ${agent.nickname} request: ${agent.pendingApproval!.operation}`}
																onClick={() =>
																	vscode.postMessage({
																		type: "respondToSubagentApproval",
																		taskId: resolvedParentTaskId,
																		groupId: group.groupId,
																		subagentTaskId: agent.taskId,
																		approvalId: agent.pendingApproval!.id,
																		approved,
																	})
																}
																className="rounded border border-vscode-button-border px-2 py-1">
																{approved ? "Approve" : "Deny"}
															</button>
														))}
													</div>
												</div>
											)}
											{preview && (
												<p
													className={cn(
														"m-0 mt-2 line-clamp-2 text-sm",
														agent.error && "text-vscode-errorForeground",
													)}>
													{preview}
												</p>
											)}
											{agent.changedFiles && agent.changedFiles.length > 0 && (
												<div className="mt-2 text-xs">
													{agent.changedFiles.length} changed file
													{agent.changedFiles.length === 1 ? "" : "s"}
												</div>
											)}
											{pacingWait && (
												<div className="mt-1 text-xs text-vscode-descriptionForeground">
													Configured request pacing: {pacingWait}
												</div>
											)}
											{agent.verification?.map((item) => (
												<div
													key={item.label}
													className="mt-1 text-xs text-vscode-descriptionForeground">
													{item.label}: {item.status.replace("_", " ")}
													{item.detail ? ` · ${item.detail}` : ""}
												</div>
											))}
											{verificationCopy && agent.parentVerification && (
												<div
													className={cn(
														"mt-2 rounded-lg border border-vscode-panel-border p-2 text-xs",
														agent.parentVerification.status === "failed" &&
															"border-vscode-testing-iconFailed/50",
													)}
													role="status">
													<div className="flex items-center gap-1 font-medium text-vscode-foreground">
														{agent.parentVerification.status === "satisfied" ? (
															<CheckCircle2 className="size-3.5 text-vscode-testing-iconPassed" />
														) : agent.parentVerification.status === "failed" ? (
															<CircleAlert className="size-3.5 text-vscode-testing-iconFailed" />
														) : agent.parentVerification.status === "pending" ? (
															<Clock3 className="size-3.5 text-vscode-editorWarning-foreground" />
														) : (
															<FileDiff className="size-3.5 text-vscode-editorWarning-foreground" />
														)}
														{verificationCopy.label}
													</div>
													<div className="mt-1 text-vscode-descriptionForeground">
														{verificationCopy.nextAction}
													</div>
												</div>
											)}
											{agent.changeSet?.partial && (
												<div className="mt-1 text-xs text-vscode-editorWarning-foreground">
													Partial changes were captured and remain reviewable.
												</div>
											)}
											{agent.changeSet?.status === "conflicted" && (
												<div className="mt-1 text-xs text-vscode-editorWarning-foreground">
													Parent files changed:{" "}
													{agent.changeSet.conflictPaths?.join(", ") ||
														"apply preflight failed"}
												</div>
											)}
											{agent.changeSet &&
												!["unavailable", "scope_violation"].includes(
													agent.changeSet.status,
												) && (
													<div className="mt-2 flex flex-wrap items-center gap-2">
														<button
															type="button"
															onClick={() => openChangeSet(agent.changeSet!.id)}
															className="inline-flex items-center gap-1 text-xs text-vscode-textLink-foreground hover:underline">
															<FileDiff className="size-3" /> Open diff
														</button>
														{canMutateChangeSet && (
															<>
																<button
																	type="button"
																	disabled={
																		!changeSetCapability?.allowed ||
																		Boolean(pendingChangeSetAction)
																	}
																	title={
																		changeSetCapability?.allowed
																			? undefined
																			: changeSetCapability?.reason
																	}
																	onClick={() =>
																		submitChangeSetAction(
																			"apply",
																			agent.changeSet!.id,
																		)
																	}
																	className="rounded border border-vscode-button-border px-2 py-1 text-xs disabled:opacity-50">
																	{pendingChangeSetAction?.action === "apply"
																		? "Applying…"
																		: agent.changeSet!.status === "conflicted"
																			? "Retry apply"
																			: "Apply changes"}
																</button>
																<button
																	type="button"
																	disabled={
																		!changeSetCapability?.allowed ||
																		Boolean(pendingChangeSetAction)
																	}
																	title={
																		changeSetCapability?.allowed
																			? undefined
																			: changeSetCapability?.reason
																	}
																	onClick={() =>
																		submitChangeSetAction(
																			"discard",
																			agent.changeSet!.id,
																		)
																	}
																	className="inline-flex items-center gap-1 text-xs text-vscode-errorForeground">
																	{pendingChangeSetAction?.action === "discard" ? (
																		<LoaderCircle className="size-3 animate-spin" />
																	) : (
																		<Trash2 className="size-3" />
																	)}
																	{pendingChangeSetAction?.action === "discard"
																		? "Discarding…"
																		: "Discard"}
																</button>
															</>
														)}
													</div>
												)}
											{canMutateChangeSet && !changeSetCapability?.allowed && (
												<div
													className="mt-1 text-xs text-vscode-descriptionForeground"
													role="status">
													{changeSetCapability?.reason ??
														"Checking whether the parent is paused…"}
												</div>
											)}
											{changeSetActionResult && (
												<div
													className={cn(
														"mt-1 text-xs",
														changeSetActionResult.success
															? "text-vscode-descriptionForeground"
															: "text-vscode-errorForeground",
													)}
													role={changeSetActionResult.success ? "status" : "alert"}>
													{changeSetActionResult.message}
												</div>
											)}
											{activeStatuses.has(agent.status) && (
												<div className="mt-2 flex flex-wrap items-center gap-2">
													{agent.status === "running" && (
														<Button
															type="button"
															variant="outline"
															size="sm"
															aria-label={`Steer ${agent.nickname}`}
															onClick={() => {
																setSteeringText("")
																setSteeringAgent(agent)
															}}>
															<MessageSquareText aria-hidden="true" /> Steer
														</Button>
													)}
													<Button
														type="button"
														variant="ghost"
														size="sm"
														disabled={cancelRequested}
														aria-label={
															cancelRequested
																? `Cancelling ${agent.nickname}`
																: `Cancel ${agent.nickname}`
														}
														onClick={() => cancelAgent(agent)}>
														<Square aria-hidden="true" />{" "}
														{cancelRequested ? "Cancelling…" : "Cancel"}
													</Button>
												</div>
											)}
											{terminal && (
												<button
													type="button"
													aria-label={`Open transcript for ${agent.nickname}`}
													onClick={() =>
														vscode.postMessage({
															type: "showTaskWithId",
															text: agent.taskId,
														})
													}
													className="mt-2 inline-flex items-center gap-1 border-0 bg-transparent p-0 text-xs text-vscode-textLink-foreground hover:underline">
													Open transcript <ExternalLink className="size-3" />
												</button>
											)}
											{agent.status === "interrupted" && (
												<div className="mt-1 text-xs text-vscode-descriptionForeground">
													Return to the parent and ask Alpha to run this delegation again.
												</div>
											)}
										</div>
									</div>
								</div>
							)
						})}
					</div>
				)}
			</section>

			<Dialog
				open={Boolean(changeSetConfirmation)}
				onOpenChange={(open) => {
					if (!open) setChangeSetConfirmation(undefined)
				}}>
				<DialogContent className="max-w-md gap-4 p-5">
					<DialogHeader>
						<DialogTitle>
							{isApplyConfirmation ? "Apply Worker changes?" : "Discard Worker changes?"}
						</DialogTitle>
						<DialogDescription>
							{isApplyConfirmation
								? `Apply ${changeSetConfirmationAgent?.nickname ?? "this Worker"}'s reviewed changes to the parent working tree. This will not stage or commit anything.`
								: `Permanently discard ${changeSetConfirmationAgent?.nickname ?? "this Worker"}'s quarantined proposal without changing the parent working tree.`}
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<DialogClose asChild>
							<Button type="button" variant="secondary">
								Cancel
							</Button>
						</DialogClose>
						<Button type="button" variant="primary" onClick={confirmChangeSetAction}>
							{isApplyConfirmation ? "Confirm apply" : "Confirm discard"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={Boolean(steeringAgent)}
				onOpenChange={(open) => {
					if (!open) closeSteeringDialog()
				}}>
				<DialogContent className="max-w-md gap-4 p-5">
					<DialogHeader>
						<DialogTitle>Steer {steeringAgent?.nickname}</DialogTitle>
						<DialogDescription>
							Send a concise correction or additional context to this active sub-agent. Its authority and
							write scope will not change.
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
