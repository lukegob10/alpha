import type { AlphaMessage } from "@alpha-code/types"

export type ActionActivityKind = "working" | "commands" | "edits" | "worked"

export interface ActionActivity {
	id: number
	startIndex: number
	endIndex: number
	kind: ActionActivityKind
	count: number
	durationMs?: number
}

const editTools = new Set(["editedExistingFile", "appliedDiff", "newFileCreated", "insertContent", "searchAndReplace"])
const failureStatuses = new Set(["error", "failed", "denied", "cancelled"])
const pendingInputAsks = new Set(["command", "followup", "tool", "use_mcp_server"])

function hasPendingUserInput(messages: AlphaMessage[], startIndex: number, endIndex: number): boolean {
	for (let index = startIndex; index <= endIndex; index++) {
		const message = messages[index]
		if (message.type === "say" && message.say === "async_user_input" && message.isAnswered !== true) return true
		if (message.type === "ask" && pendingInputAsks.has(message.ask ?? "") && message.isAnswered !== true)
			return true
	}
	return false
}

function toolKind(message: AlphaMessage): ActionActivityKind | undefined {
	try {
		const { tool, status, changeStatus, commandExecutionId } = JSON.parse(message.text || "{}") as {
			tool?: string
			status?: string
			changeStatus?: string
			commandExecutionId?: string
		}
		if (tool === "ticket" || (status && failureStatuses.has(status))) return undefined
		if (changeStatus === "applied" && commandExecutionId) return "commands"
		return tool && editTools.has(tool) ? "edits" : "working"
	} catch {
		return "working"
	}
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
		try {
			const info = JSON.parse(message.text || "{}") as { streamingFailedMessage?: string; cancelReason?: string }
			return info.streamingFailedMessage || info.cancelReason ? undefined : "working"
		} catch {
			return "working"
		}
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
	const flush = (endIndex: number) => {
		if (start < 0) return
		const activity: ActionActivity = { id: messages[start].ts, startIndex: start, endIndex, kind, count }
		for (let index = start; index <= endIndex; index++) byIndex.set(index, activity)
		start = -1
		count = 0
		mixed = false
	}
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		// A pending approval can contain buttons inside its row and must never be hidden.
		const currentKind =
			message.ts === pendingApprovalTs ||
			message.ts === failedApiRequestTs ||
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
		count++
	}
	flush(messages.length - 1)
	return byIndex
}

/** Groups a completed assistant turn while leaving its prompt and final answer visible. */
export function getCompletedTurnActivity(
	messages: AlphaMessage[],
	initialPromptTs?: number,
	currentTurnCompleted = false,
): Map<number, ActionActivity> {
	const byIndex = new Map<number, ActionActivity>()
	let prompt =
		initialPromptTs !== undefined && Number.isFinite(initialPromptTs) && initialPromptTs > 0
			? { index: -1, ts: initialPromptTs }
			: undefined
	const addTurn = (promptStart: { index: number; ts: number }, summaryIndex: number) => {
		const startIndex = promptStart.index + 1
		const endIndex = summaryIndex - 1
		if (startIndex > endIndex || hasPendingUserInput(messages, startIndex, endIndex)) return

		const activity: ActionActivity = {
			id: messages[startIndex].ts,
			startIndex,
			endIndex,
			kind: "worked",
			count: endIndex - startIndex + 1,
			durationMs: Math.max(0, messages[summaryIndex].ts - promptStart.ts),
		}
		for (let row = startIndex; row <= endIndex; row++) byIndex.set(row, activity)
	}

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index]
		if (message.type === "say" && message.say === "user_feedback") {
			prompt = { index, ts: message.ts }
			continue
		}

		if (message.type !== "say" || message.say !== "completion_result" || message.partial === true) continue

		if (prompt) addTurn(prompt, index)
		prompt = undefined
	}

	if (currentTurnCompleted && prompt) {
		for (let index = messages.length - 1; index > prompt.index; index--) {
			const message = messages[index]
			if (message.type === "say" && message.say === "text" && message.partial !== true) {
				addTurn(prompt, index)
				break
			}
		}
	}

	return byIndex
}
