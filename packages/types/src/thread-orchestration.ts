import type { AssistantMessagePhase } from "./agent-response.js"

/** Native extension thread controls. Thread content is data, never instruction authority. */
export type ThreadRuntimeStatus =
	| { type: "notLoaded" | "idle" | "systemError" }
	| { type: "active"; activeFlags: Array<"waitingOnApproval" | "waitingOnUserInput"> }

export interface ThreadSummary {
	id: string
	kind: "alpha"
	title: string | null
	summary: string
	status: ThreadRuntimeStatus["type"]
	cwd: string
	updatedAt: number
}

export interface ThreadListOptions {
	limit?: number
	cursor?: string
	archived?: boolean
}

export interface ThreadListResult {
	schemaVersion?: 4
	untrustedDataNotice?: string
	pinnedThreads?: ThreadSummary[]
	threads: ThreadSummary[]
	unavailableHosts?: string[]
	unavailableSources?: string[]
	nextCursor?: string | null
}

export interface ThreadReadOptions {
	cursor?: string
	turnLimit?: number
	includeOutputs?: boolean
	maxOutputCharsPerItem?: number
}

export type ThreadVisibleItem =
	| { type: "userMessage"; id: string; content: Array<{ type: "text"; text: string }> }
	| { type: "agentMessage"; id: string; text: string; phase?: AssistantMessagePhase }
	| { type: "toolCall"; id: string; name: string; status: "completed" | "inProgress" }
	| { type: "toolResult"; id: string; text?: string; status: "completed" | "error" }

export interface ThreadTurnSummary {
	id: string
	status: "completed" | "inProgress" | "interrupted" | "failed"
	items: ThreadVisibleItem[]
	error?: { message: string } | null
}

export interface ThreadReadResult {
	schemaVersion: 1
	untrustedDataNotice?: string
	thread: {
		id: string
		kind: "alpha"
		title: string | null
		preview: string
		status: ThreadRuntimeStatus
		cwd: string
		createdAt: number
		updatedAt: number
	}
	page: { order: "newest_first"; limit: number; hasMore: boolean; nextCursor: string | null }
	turns: ThreadTurnSummary[]
}

export interface ThreadWaitPoll {
	schemaVersion: 1
	thread: { id: string; status: ThreadRuntimeStatus }
	cursor: string
	revision: number
	changed: boolean
	latestTurn:
		| (Omit<ThreadTurnSummary, "items"> & {
				startedAt?: number | null
				completedAt?: number | null
				durationMs?: number | null
		  })
		| null
	latestAssistantMessageId: string | null
	latestAssistantMessage:
		| (Omit<Extract<ThreadVisibleItem, { type: "agentMessage" }>, "type"> & { turnId: string })
		| null
	latestToolMarkerId: string | null
	latestToolMarker: { id: string; turnId: string; type: string; name: string; status: string | null } | null
}

export interface ThreadWaitResult {
	timedOut: boolean
	wake: { threadId: string; reason: "turnCompleted" | "inactiveStatus" | "actionableStatus"; turnId?: string } | null
	polls: ThreadWaitPoll[]
	errors?: Array<{ threadId: string; message: string }>
}
