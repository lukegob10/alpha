import {
	threadToolParamsSchemas,
	type ThreadToolName,
	type ThreadReadResult,
	type ThreadWaitPoll,
	type ThreadWaitResult,
	type WaitThreadsParams,
} from "@alpha-code/types"

import type { NativeToolArgs } from "../../shared/tools"
import { findLast } from "../../shared/array"
import type { Task } from "../task/Task"
import type { CrossTaskOrchestrationProvider } from "../webview/CrossTaskOrchestration"
import { BaseTool, type ToolCallbacks } from "./BaseTool"
import { serializeThreadResult } from "./serializeThreadResult"

const mutationTools: ReadonlySet<ThreadToolName> = new Set([
	"create_thread",
	"fork_thread",
	"send_message_to_thread",
	"set_thread_title",
	"set_thread_archived",
])

const receiptThreadId = "x".repeat(64)
const forkContinuation =
	"The fork is idle and contains completed history. Send a follow-up to threadId to continue work there."

class ThreadReceiptBudgetError extends Error {}

function serializeReceipt(result: unknown, budget?: number): string {
	try {
		return serializeThreadResult(result, budget)
	} catch (error) {
		if (error instanceof Error && error.message === "Thread response metadata exceeds the output budget") {
			throw new ThreadReceiptBudgetError(error.message)
		}
		throw error
	}
}

/** Reserve a receipt for the longest host-issued identity before accepting a mutation. */
function mutationReceipt(name: ThreadToolName, params: unknown): unknown {
	switch (name) {
		case "create_thread":
		case "send_message_to_thread":
			return { threadId: receiptThreadId }
		case "fork_thread":
			return {
				environment: { type: "same-directory" },
				sourceThreadId: receiptThreadId,
				threadId: receiptThreadId,
				continuation: forkContinuation,
			}
		case "set_thread_title":
			return {
				threadId: receiptThreadId,
				title: threadToolParamsSchemas.set_thread_title.parse(params).title.trim(),
			}
		case "set_thread_archived":
			return { threadId: receiptThreadId, archived: false }
		default:
			throw new Error("Only thread mutations require a receipt reservation")
	}
}

const providerMethod = {
	list_threads: "listIndependentThreads",
	list_archived_threads: "listIndependentThreads",
	read_thread: "readIndependentThread",
	wait_threads: "readIndependentThread",
	create_thread: "createIndependentTask",
	fork_thread: "forkIndependentTask",
	send_message_to_thread: "sendIndependentTaskMessage",
	set_thread_title: "setIndependentTaskTitle",
	set_thread_archived: "setIndependentTaskArchived",
} as const

function getProvider(task: Task, name: ThreadToolName): CrossTaskOrchestrationProvider {
	const provider = task.providerRef.deref() as Partial<CrossTaskOrchestrationProvider> | undefined
	if (typeof provider?.[providerMethod[name]] !== "function") {
		throw new Error("Thread orchestration is unavailable in this host")
	}
	return provider as CrossTaskOrchestrationProvider
}

/** Race only local reads; the shared abort signal also cancels the owning host operation. */
async function abortableRead<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted()
	let rejectAbort: (reason?: unknown) => void = () => undefined
	const aborted = new Promise<never>((_resolve, reject) => {
		rejectAbort = reject
	})
	const onAbort = () => rejectAbort(signal.reason)
	signal.addEventListener("abort", onAbort, { once: true })
	try {
		return await Promise.race([read(), aborted])
	} finally {
		signal.removeEventListener("abort", onAbort)
	}
}

function waitForRefresh(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve()
	return new Promise((resolve) => {
		const finish = () => {
			clearTimeout(timer)
			signal.removeEventListener("abort", finish)
			resolve()
		}
		const timer = setTimeout(finish, 1_000)
		signal.addEventListener("abort", finish, { once: true })
	})
}

function threadPoll(read: ThreadReadResult, afterCursor?: string): ThreadWaitPoll {
	const turn = read.turns[0]
	const latestItem = turn?.items.at(-1)
	const assistantMessage = turn ? findLast(turn.items, (item) => item.type === "agentMessage") : undefined
	const toolMarker = turn ? findLast(turn.items, (item) => item.type === "toolCall") : undefined
	const cursor = JSON.stringify({
		updatedAt: read.thread.updatedAt,
		status: read.thread.status,
		turnId: turn?.id ?? null,
		turnStatus: turn?.status ?? null,
		latestItemId: latestItem?.id ?? null,
	})
	const changed = afterCursor !== cursor
	return {
		schemaVersion: 1,
		thread: { id: read.thread.id, status: read.thread.status },
		cursor,
		revision: read.thread.updatedAt,
		changed,
		latestTurn: turn ? { id: turn.id, status: turn.status, error: turn.error ?? null } : null,
		latestAssistantMessageId: assistantMessage?.id ?? null,
		latestAssistantMessage:
			changed && assistantMessage?.type === "agentMessage" && turn
				? {
						id: assistantMessage.id,
						turnId: turn.id,
						text: assistantMessage.text,
						phase: assistantMessage.phase,
					}
				: null,
		latestToolMarkerId: toolMarker?.id ?? null,
		latestToolMarker:
			changed && toolMarker?.type === "toolCall" && turn
				? {
						id: toolMarker.id,
						turnId: turn.id,
						type: toolMarker.type,
						name: toolMarker.name,
						status: toolMarker.status,
					}
				: null,
	}
}

function actionableWake(poll: ThreadWaitPoll): ThreadWaitResult["wake"] {
	const status = poll.thread.status
	if (status.type === "idle" && poll.latestTurn) {
		return poll.changed && poll.latestTurn.status !== "inProgress"
			? { threadId: poll.thread.id, reason: "turnCompleted", turnId: poll.latestTurn.id }
			: null
	}
	if (status.type === "idle" || status.type === "notLoaded" || status.type === "systemError") {
		return { threadId: poll.thread.id, reason: "inactiveStatus" }
	}
	if (status.type === "active" && status.activeFlags.length > 0) {
		return { threadId: poll.thread.id, reason: "actionableStatus" }
	}
	return null
}

const peerBecameActionable = new Error("Another task became actionable")

async function readWaitSnapshots(
	task: Task,
	provider: CrossTaskOrchestrationProvider,
	targets: WaitThreadsParams["targets"],
	signal: AbortSignal,
): Promise<Array<PromiseSettledResult<ThreadReadResult>>> {
	const controller = new AbortController()
	const onAbort = () => controller.abort(signal.reason)
	signal.addEventListener("abort", onAbort, { once: true })
	let notifyActionable: () => void = () => undefined
	const actionable = new Promise<void>((resolve) => {
		notifyActionable = resolve
	})
	// A slow read cannot prevent the next status refresh for already running peers.
	const timer = setTimeout(() => controller.abort(new Error("Thread status snapshot timed out")), 1_000)
	try {
		const settled = Promise.allSettled(
			targets.map(async (target) => {
				const read = await abortableRead(
					() =>
						provider.readIndependentThread(
							task,
							target.threadId,
							{ turnLimit: 1, includeOutputs: false, maxOutputCharsPerItem: 2_000 },
							controller.signal,
						),
					controller.signal,
				)
				if (actionableWake(threadPoll(read, target.afterCursor))) notifyActionable()
				return read
			}),
		)
		await Promise.race([settled, actionable])
		controller.abort(peerBecameActionable)
		return await settled
	} finally {
		clearTimeout(timer)
		signal.removeEventListener("abort", onAbort)
		controller.abort()
	}
}

async function waitForThreads(
	task: Task,
	provider: CrossTaskOrchestrationProvider,
	params: WaitThreadsParams,
	signal?: AbortSignal,
): Promise<ThreadWaitResult> {
	const uniqueTargets = new Set(params.targets.map((target) => target.threadId))
	if (uniqueTargets.has(task.taskId)) throw new Error("wait_threads cannot wait on the calling task")
	if (uniqueTargets.size !== params.targets.length) throw new Error("wait_threads received duplicate target tasks")
	signal?.throwIfAborted()
	const timeoutMs = params.timeoutMs ?? 120_000
	const controller = new AbortController()
	const onAbort = () => controller.abort(signal?.reason)
	signal?.addEventListener("abort", onAbort, { once: true })
	const deadline = Date.now() + timeoutMs
	const timer = setTimeout(() => controller.abort(new Error("Thread wait timed out")), timeoutMs || 5_000)
	let polls: ThreadWaitPoll[] = []
	let errors: NonNullable<ThreadWaitResult["errors"]> = []
	try {
		while (!controller.signal.aborted) {
			// At most eight reads are active. All settle before a refresh or return.
			const snapshots = await readWaitSnapshots(task, provider, params.targets, controller.signal)
			signal?.throwIfAborted()
			polls = []
			errors = []
			for (let index = 0; index < snapshots.length; index++) {
				const snapshot = snapshots[index]
				const target = params.targets[index]
				if (snapshot.status === "fulfilled") {
					polls.push(threadPoll(snapshot.value, target.afterCursor))
				} else if (snapshot.reason !== peerBecameActionable) {
					const message = controller.signal.aborted
						? "Timed out while reading task status"
						: snapshot.reason instanceof Error
							? snapshot.reason.message
							: String(snapshot.reason)
					errors.push({ threadId: target.threadId, message: message.slice(0, 248) })
				}
			}
			const wake = polls.map(actionableWake).find((item) => item !== null) ?? null
			if (wake || polls.length === 0 || Date.now() >= deadline || controller.signal.aborted) {
				return {
					timedOut: !wake && (polls.length > 0 || (timeoutMs > 0 && Date.now() >= deadline)),
					wake,
					polls,
					...(errors.length ? { errors } : {}),
				}
			}
			await waitForRefresh(controller.signal)
		}
		signal?.throwIfAborted()
		return { timedOut: true, wake: null, polls, ...(errors.length ? { errors } : {}) }
	} finally {
		clearTimeout(timer)
		signal?.removeEventListener("abort", onAbort)
		controller.abort()
	}
}

async function dispatch(
	name: ThreadToolName,
	params: unknown,
	task: Task,
	provider: CrossTaskOrchestrationProvider,
	signal?: AbortSignal,
): Promise<unknown> {
	switch (name) {
		case "list_threads": {
			const args = threadToolParamsSchemas.list_threads.parse(params)
			return provider.listIndependentThreads(task, { limit: args.limit ?? 10, archived: false }, signal)
		}
		case "list_archived_threads": {
			const args = threadToolParamsSchemas.list_archived_threads.parse(params)
			return provider.listIndependentThreads(
				task,
				{ limit: args.limit ?? 10, archived: true, cursor: args.cursor },
				signal,
			)
		}
		case "read_thread": {
			const args = threadToolParamsSchemas.read_thread.parse(params)
			return provider.readIndependentThread(
				task,
				args.threadId,
				{
					cursor: args.cursor,
					turnLimit: args.turnLimit ?? 1,
					includeOutputs: args.includeOutputs ?? false,
					maxOutputCharsPerItem: args.maxOutputCharsPerItem ?? 2_000,
				},
				signal,
			)
		}
		case "wait_threads":
			return waitForThreads(task, provider, threadToolParamsSchemas.wait_threads.parse(params), signal)
		case "create_thread": {
			const args = threadToolParamsSchemas.create_thread.parse(params)
			const created = await provider.createIndependentTask(task, args.prompt, "shared", signal, {
				title: args.title,
				provider: args.provider,
				profile: args.profile,
				model: args.model,
				reasoningEffort: args.reasoning_effort,
				notifyOnCompletion: false,
			})
			return { threadId: created.task_id }
		}
		case "fork_thread": {
			const args = threadToolParamsSchemas.fork_thread.parse(params)
			const forked = await provider.forkIndependentTask(task, args.threadId, signal, {
				provider: args.provider,
				profile: args.profile,
				model: args.model,
				reasoningEffort: args.reasoning_effort,
			})
			return {
				environment: { type: "same-directory" },
				sourceThreadId: args.threadId ?? task.taskId,
				threadId: forked.task_id,
				continuation: forkContinuation,
			}
		}
		case "send_message_to_thread": {
			const args = threadToolParamsSchemas.send_message_to_thread.parse(params)
			const delivered = await provider.sendIndependentTaskMessage(task, args.threadId, args.prompt, {
				provider: args.provider,
				profile: args.profile,
				model: args.model,
				reasoningEffort: args.reasoning_effort,
				signal,
			})
			return { threadId: delivered.task_id }
		}
		case "set_thread_title": {
			const args = threadToolParamsSchemas.set_thread_title.parse(params)
			const updated = await provider.setIndependentTaskTitle(task, args.threadId, args.title.trim(), signal)
			return { threadId: updated.task_id, title: updated.title ?? args.title.trim() }
		}
		case "set_thread_archived": {
			const args = threadToolParamsSchemas.set_thread_archived.parse(params)
			const updated = await provider.setIndependentTaskArchived(task, args.threadId, args.archived, signal)
			return { threadId: updated.task_id, archived: updated.archived ?? args.archived }
		}
	}
}

export class ThreadOrchestrationTool<TName extends ThreadToolName> extends BaseTool<TName> {
	constructor(readonly name: TName) {
		super()
	}

	async execute(params: NativeToolArgs[TName], task: Task, callbacks: ToolCallbacks): Promise<void> {
		const finish = (status: "success" | "error" | "denied" | "cancelled", result: unknown) => {
			const serialized = serializeReceipt(result, callbacks.getRemainingOutputChars?.())
			callbacks.setResultMetadata?.({ status })
			callbacks.pushToolResult(serialized)
		}
		try {
			const parsed = threadToolParamsSchemas[this.name].parse(params)
			const provider = getProvider(task, this.name)
			callbacks.signal?.throwIfAborted()
			if (mutationTools.has(this.name)) {
				const approved = await callbacks.askApproval("tool", JSON.stringify({ tool: this.name, ...parsed }))
				callbacks.signal?.throwIfAborted()
				if (!approved) return finish("denied", { status: "denied", tool: this.name })
				// Approval feedback can consume output capacity. The remaining budget is
				// stable after this point and must preserve the operation's handle.
				serializeReceipt(mutationReceipt(this.name, parsed), callbacks.getRemainingOutputChars?.())
			}
			const result = await dispatch(this.name, parsed, task, provider, callbacks.signal)
			if (!mutationTools.has(this.name)) callbacks.signal?.throwIfAborted()
			finish("success", result)
		} catch (error) {
			if (
				callbacks.signal?.aborted &&
				(error === callbacks.signal.reason || (error instanceof Error && error.name === "AbortError"))
			) {
				finish("cancelled", { status: "cancelled", tool: this.name })
				return
			}
			const message = error instanceof Error ? error.message : String(error)
			task.recordToolError(this.name, message)
			task.didToolFailInCurrentTurn = true
			if (error instanceof ThreadReceiptBudgetError) {
				callbacks.setResultMetadata?.({ status: "error" })
				await callbacks.handleError(`executing ${this.name}`, error)
				return
			}
			finish("error", { status: "error", error: message })
		}
	}
}

export const listThreadsTool = new ThreadOrchestrationTool("list_threads")
export const listArchivedThreadsTool = new ThreadOrchestrationTool("list_archived_threads")
export const readThreadTool = new ThreadOrchestrationTool("read_thread")
export const waitThreadsTool = new ThreadOrchestrationTool("wait_threads")
export const createThreadTool = new ThreadOrchestrationTool("create_thread")
export const forkThreadTool = new ThreadOrchestrationTool("fork_thread")
export const sendMessageToThreadTool = new ThreadOrchestrationTool("send_message_to_thread")
export const setThreadTitleTool = new ThreadOrchestrationTool("set_thread_title")
export const setThreadArchivedTool = new ThreadOrchestrationTool("set_thread_archived")
