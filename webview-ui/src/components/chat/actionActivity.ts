import type { AlphaMessage } from "@alpha-code/types"

import { projectTranscriptTurns, transcriptTurnIdentity, type TranscriptPrompt } from "./utils/transcriptTurns"
import { createMessagePayloadSelector } from "./utils/messagePayload"

export type ActionActivityKind = "working" | "commands" | "edits" | "worked"

export interface ActionActivity {
	id: string | number
	startIndex: number
	endIndex: number
	kind: ActionActivityKind
	count: number
	durationMs?: number
	/** Completed turns can leave pending input, failures, and unattributed rows outside their disclosure. */
	memberIndices?: readonly number[]
}

const editTools = new Set(["editedExistingFile", "appliedDiff", "newFileCreated", "insertContent", "searchAndReplace"])
const failureStatuses = new Set(["error", "failed", "denied", "cancelled"])

function hasToolFailure(payload: Record<string, unknown> | undefined): boolean {
	return Boolean(
		payload &&
			(payload.cancelled === true ||
				[payload.status, payload.lifecycleStatus, payload.changeStatus].some(
					(status) => typeof status === "string" && failureStatuses.has(status),
				)),
	)
}

const payloadPresentation = createMessagePayloadSelector((payload) => {
	const failed = hasToolFailure(payload)
	let kind: ActionActivityKind | undefined = "working"
	if (payload?.tool === "ticket" || failed) kind = undefined
	else if (payload?.changeStatus === "applied" && payload.commandExecutionId) kind = "commands"
	else if (typeof payload?.tool === "string" && editTools.has(payload.tool)) kind = "edits"
	return { kind, failed, requestFailed: Boolean(payload?.streamingFailedMessage || payload?.cancelReason) }
})

function needsVisibleAttention(message: AlphaMessage): boolean {
	if (message.turn?.terminalStatus && message.turn.terminalStatus !== "completed") return true
	if (message.toolApprovalRequest && message.isAnswered !== true) return true
	if (message.type === "ask" && message.isAnswered !== true && message.ask !== "completion_result") return true
	if (message.type !== "say") return false
	if (message.say === "async_user_input" && message.isAnswered !== true) return true
	if (
		message.say === "error" ||
		message.say === "diff_error" ||
		message.say === "condense_context_error" ||
		message.say === "shell_integration_warning"
	)
		return true
	if (message.say === "tool") return payloadPresentation(message).failed
	if (message.say === "api_req_started") return payloadPresentation(message).requestFailed
	return Boolean(
		message.subagentGroup?.agents.some(
			(agent) =>
				agent.pendingApproval ||
				agent.parentVerification?.blocking ||
				(agent.changeSet && ["pending_review", "conflicted"].includes(agent.changeSet.status)),
		),
	)
}

function toolKind(message: AlphaMessage): ActionActivityKind | undefined {
	return payloadPresentation(message).kind
}

function actionKind(message: AlphaMessage): ActionActivityKind | undefined {
	if (message.type === "ask") {
		if (message.ask === "command" || message.ask === "command_output") return "commands"
		if (message.ask === "tool") return toolKind(message)
		return message.ask === "use_mcp_server" ? "working" : undefined
	}
	if (message.say === "command_output") return "commands"
	if (message.say === "tool") return toolKind(message)
	if (message.say === "api_req_started") {
		return payloadPresentation(message).requestFailed ? undefined : "working"
	}
	if (
		message.say === "mcp_server_response" ||
		message.say === "codebase_search_result" ||
		message.say === "checkpoint_saved"
	)
		return "working"
	return undefined
}

/** Fold only consecutive presentation actions. Narrative, errors, and input boundaries remain separate rows. */
export function getActionActivity(
	messages: AlphaMessage[],
	pendingApprovalTs?: number,
	failedApiRequestTs?: number,
): Map<number, ActionActivity> {
	const byIndex = new Map<number, ActionActivity>()
	let start = -1
	let kind: ActionActivityKind = "working"
	let count = 0
	let mixed = false
	let turnIdentity: string | undefined
	const flush = (endIndex: number) => {
		if (start < 0) return
		const activity: ActionActivity = { id: messages[start].ts, startIndex: start, endIndex, kind, count }
		for (let index = start; index <= endIndex; index++) byIndex.set(index, activity)
		start = -1
		count = 0
		mixed = false
		turnIdentity = undefined
	}
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		const currentTurnIdentity = message.turn ? transcriptTurnIdentity(message.turn) : undefined
		if (turnIdentity && currentTurnIdentity && turnIdentity !== currentTurnIdentity) flush(index - 1)
		// A pending approval can contain buttons inside its row and must never be hidden.
		const currentKind =
			message.ts === pendingApprovalTs ||
			message.ts === failedApiRequestTs ||
			(message.type === "ask" && message.partial === true) ||
			(message.turn !== undefined && message.type === "ask" && message.isAnswered !== true) ||
			(message.turn?.terminalStatus && message.turn.terminalStatus !== "completed") ||
			(message.toolApprovalRequest && !message.isAnswered)
				? undefined
				: actionKind(message)
		if (!currentKind) {
			flush(index - 1)
			continue
		}
		if (start < 0) {
			start = index
			kind = currentKind
		} else if (currentKind !== "working" && !mixed) {
			if (kind !== "working" && kind !== currentKind) {
				kind = "working"
				mixed = true
			} else {
				kind = currentKind
			}
		}
		turnIdentity ??= currentTurnIdentity
		count++
	}
	flush(messages.length - 1)
	return byIndex
}

/** Groups a completed assistant turn while leaving its prompt and final answer visible. */
export function getCompletedTurnActivity(
	messages: AlphaMessage[],
	initialPrompt?: TranscriptPrompt,
	currentTurnCompleted = false,
): Map<number, ActionActivity> {
	const byIndex = new Map<number, ActionActivity>()
	const turns = projectTranscriptTurns(messages, initialPrompt)
	for (const turn of turns) {
		let summaryIndex = turn.terminalStatus === "completed" ? turn.terminalIndex : undefined
		// Older hosts published ordinary final text before the completion review boundary.
		if (
			summaryIndex === undefined &&
			turn.source === "legacy" &&
			turn.promptIndex !== undefined &&
			turn === turns.at(-1) &&
			currentTurnCompleted
		) {
			summaryIndex = turn.indices.findLast(
				(index) => messages[index].type === "say" && messages[index].say === "text" && !messages[index].partial,
			)
		}
		if (summaryIndex === undefined || (turn.source === "legacy" && turn.promptIndex === undefined)) continue
		const memberIndices = turn.indices.filter(
			(index) =>
				index !== turn.promptIndex &&
				(turn.source === "canonical" ? index !== summaryIndex : index < summaryIndex) &&
				!needsVisibleAttention(messages[index]),
		)
		if (memberIndices.length === 0) continue
		const activity: ActionActivity = {
			id: turn.source === "canonical" ? turn.id : messages[memberIndices[0]].ts,
			startIndex: memberIndices[0],
			endIndex: memberIndices[memberIndices.length - 1],
			kind: "worked",
			count: memberIndices.length,
			durationMs: Math.max(0, messages[summaryIndex].ts - turn.startTs),
			memberIndices,
		}
		for (const index of memberIndices) byIndex.set(index, activity)
	}

	return byIndex
}
