import { afterEach, describe, expect, it, vi } from "vitest"
import type { AlphaMessage, ToolApprovalRequest, ToolProgressStatus } from "@alpha-code/types"
import { consolidateCommands } from "@alpha-code/core"

import { Task } from "../Task"

type SayOptions = NonNullable<Parameters<Task["say"]>[6]>

function barrier() {
	let release!: () => void
	const promise = new Promise<void>((resolve) => (release = resolve))
	return { promise, release }
}

function createTask(seed: AlphaMessage[] = []) {
	let nextTimestamp = 1_000
	const clock = vi.spyOn(Date, "now").mockImplementation(() => nextTimestamp++)
	const messages = structuredClone(seed)
	const created: AlphaMessage[] = []
	const updated: AlphaMessage[] = []
	const persisted: AlphaMessage[][] = []
	const events: string[] = []
	const previewCurrent = vi.fn((_epoch: number) => true)
	const saveAlphaMessages = vi.fn(async () => {
		events.push("save")
		persisted.push(structuredClone(messages))
		return true
	})
	const publishAlphaMessageCreated = vi.fn(async (message: AlphaMessage, _stateUpdate?: "full" | "task") => {
		events.push("created")
		created.push(structuredClone(message))
	})
	const updateAlphaMessage = vi.fn(async (message: AlphaMessage) => {
		events.push("updated")
		updated.push(structuredClone(message))
	})
	// The actual say/add methods own mutation and ordering; only storage/publication are captured.
	const task = {
		taskId: "command-output-task",
		instanceId: "primary-instance",
		taskKind: "primary",
		cwd: process.cwd(),
		abort: false,
		abandoned: false,
		alphaMessages: messages,
		apiConversationHistory: [],
		lastMessageTs: 900,
		captureMessageTurn: Task.prototype.captureMessageTurn,
		getLastNonAgentMessage: Task.prototype["getLastNonAgentMessage"],
		observeUiMessageTimestamps: Task.prototype["observeUiMessageTimestamps"],
		reserveUiMessageTimestamp: Task.prototype["reserveUiMessageTimestamp"],
		isStreamingPreviewEpochCurrent: previewCurrent,
		addToAlphaMessages: Task.prototype["addToAlphaMessages"],
		publishAlphaMessageCreated,
		saveAlphaMessages,
		updateAlphaMessage,
		providerRef: { deref: () => undefined },
		getStepApprovalMode: () => "ask",
		approvalStateForAsk: () => undefined,
		getOffscreenAutoAskResponse: () => undefined,
		messageQueueService: { isEmpty: () => true, releaseMessage: vi.fn(), flush: vi.fn(async () => {}) },
		emit: vi.fn(),
		invalidateGoalContinuation: vi.fn(),
		cancelAutoApprovalTimeout: Task.prototype.cancelAutoApprovalTimeout,
		resetMistakeRecoveryState: vi.fn(),
		resetCompletionRecoveryState: vi.fn(),
		checkpointSave: vi.fn(async () => {}),
		handleWebviewAskResponse: Task.prototype.handleWebviewAskResponse,
		approveAsk: Task.prototype.approveAsk,
		denyAsk: Task.prototype.denyAsk,
		releaseQueuedAskInput: Task.prototype["releaseQueuedAskInput"],
		ask: Task.prototype.ask,
		reviewToolApproval: vi.fn(async () => undefined),
		markToolApprovalPromptAnswered: Task.prototype["markToolApprovalPromptAnswered"],
		findMessageByTimestamp: Task.prototype["findMessageByTimestamp"],
		getTaskMode: vi.fn(async () => "code"),
		commitAlphaMessageMutation: Task.prototype["commitAlphaMessageMutation"],
		enqueueAlphaMessagesSave: vi.fn(async (snapshot?: () => AlphaMessage[], onPersisted?: () => void) => {
			persisted.push(structuredClone(snapshot?.() ?? messages))
			onPersisted?.()
			return true
		}),
		invalidateBackgroundUsageDrain: vi.fn(),
		requireAlphaMessagesSaved: Task.prototype["requireAlphaMessagesSaved"],
	} as unknown as Task
	const output = (
		text: string,
		partial: boolean | undefined,
		commandExecutionId?: string,
		options: SayOptions = {},
	) =>
		Task.prototype.say.call(task, "command_output", text, undefined, partial, undefined, undefined, {
			isNonInteractive: true,
			...options,
			...(commandExecutionId === undefined ? {} : { commandExecutionId }),
		})
	return {
		task,
		clock,
		messages,
		created,
		updated,
		persisted,
		events,
		previewCurrent,
		saveAlphaMessages,
		publishAlphaMessageCreated,
		updateAlphaMessage,
		output,
	}
}

function partialOutput(ts: number, text: string, commandExecutionId?: string): AlphaMessage {
	return {
		ts,
		type: "say",
		say: "command_output",
		text,
		partial: true,
		...(commandExecutionId === undefined ? {} : { commandExecutionId }),
	}
}

function answerNextAsk(
	fixture: ReturnType<typeof createTask>,
	response: "yesButtonClicked" | "noButtonClicked" | "messageResponse" = "yesButtonClicked",
) {
	const publish = fixture.publishAlphaMessageCreated.getMockImplementation()!
	fixture.publishAlphaMessageCreated.mockImplementationOnce(async (message, stateUpdate) => {
		await publish(message, stateUpdate)
		expect(message.type).toBe("ask")
		expect(fixture.task.handleWebviewAskResponse(response, undefined, undefined, undefined, message.ts)).toBe(true)
	})
}

function commandApproval(taskId: string): ToolApprovalRequest {
	return {
		requestId: "owned-command-approval",
		taskId,
		callId: "command-call",
		toolName: "execute_command",
		askType: "command",
		description: "rg proof src",
		forceApproval: false,
		requiresExplicitApproval: true,
		availableDecisions: ["approve_once", "deny", "abort"],
	}
}

afterEach(() => {
	vi.restoreAllMocks()
	vi.useRealTimers()
})

describe("Task command output correlation", () => {
	it.each([undefined, true, false])(
		"creates a correlated output row and storage snapshot (partial=%s)",
		async (partial) => {
			const fixture = createTask()
			await fixture.output("command output", partial, "1001", { stateUpdate: "task" })

			expect(fixture.messages).toHaveLength(1)
			expect(fixture.messages[0]).toMatchObject({
				say: "command_output",
				text: "command output",
				commandExecutionId: "1001",
			})
			expect(Boolean(fixture.messages[0].partial)).toBe(partial === true)
			expect(fixture.created).toEqual(fixture.messages)
			expect(fixture.persisted).toEqual([fixture.messages])
			expect(fixture.publishAlphaMessageCreated).toHaveBeenCalledExactlyOnceWith(fixture.messages[0], "task")
			expect(fixture.events).toEqual(["created", "save"])
			expect(fixture.task.lastMessageTs).toBe(900)
			expect(fixture.task.apiConversationHistory).toEqual([])
		},
	)

	it.each([true, false])(
		"updates the same correlated partial row without changing its identity (partial=%s)",
		async (partial) => {
			const fixture = createTask([partialOutput(42, "first", "1001")])
			await fixture.output("latest", partial, "1001")

			expect(fixture.messages).toEqual([
				expect.objectContaining({ ts: 42, text: "latest", partial, commandExecutionId: "1001" }),
			])
			expect(fixture.created).toEqual([])
			expect(fixture.updated).toEqual(fixture.messages)
			expect(fixture.task.lastMessageTs).toBe(900)
			if (partial) expect(fixture.persisted).toEqual([])
			else expect(fixture.persisted).toEqual([fixture.messages])
		},
	)

	it("keeps interleaved command rows in first-arrival order and finalizes each original partial", async () => {
		const fixture = createTask()
		await fixture.output("A first", true, "1001")
		await fixture.output("B first", true, "1002")
		const timestamps = fixture.messages.map(({ ts }) => ts)
		await fixture.output("A latest", true, "1001")
		expect(fixture.messages.map(({ text }) => text)).toEqual(["A latest", "B first"])
		await fixture.output("A final", false, "1001")
		const completedA = structuredClone(fixture.messages[0])
		await fixture.output("B latest", true, "1002")
		await fixture.output("B final", false, "1002")

		expect(fixture.messages).toHaveLength(2)
		expect(fixture.created).toHaveLength(2)
		expect(fixture.messages.map(({ ts }) => ts)).toEqual(timestamps)
		expect(
			fixture.messages.map(({ text, commandExecutionId, partial }) => [text, commandExecutionId, partial]),
		).toEqual([
			["A final", "1001", false],
			["B final", "1002", false],
		])
		expect(fixture.messages[0]).toEqual(completedA)
		expect(fixture.updated).toHaveLength(4)
		expect(fixture.persisted.at(-1)).toEqual(fixture.messages)
		expect(fixture.task.lastMessageTs).toBe(900)
	})

	it("preserves a tagged completed row after duplicate final and delayed partial publications", async () => {
		const fixture = createTask([partialOutput(42, "preview", "1001")])
		await fixture.output("authoritative final", false, "1001")
		const completed = structuredClone(fixture.messages)
		const snapshots = structuredClone(fixture.persisted)
		await fixture.output("duplicate final", false, "1001")
		await fixture.output("late partial", true, "1001")

		expect(fixture.messages).toEqual(completed)
		expect(fixture.created).toEqual([])
		expect(fixture.updated).toHaveLength(1)
		expect(fixture.persisted).toEqual(snapshots)
	})

	it("retains standalone undefined output publications after a tagged boolean completion", async () => {
		const fixture = createTask([partialOutput(42, "preview", "1001")])
		await fixture.output("completed", false, "1001")
		await fixture.output("standalone detail", undefined, "1001")

		expect(fixture.messages.map(({ text, commandExecutionId }) => [text, commandExecutionId])).toEqual([
			["completed", "1001"],
			["standalone detail", "1001"],
		])
		expect(fixture.messages[0]).toMatchObject({ ts: 42, partial: false })
		expect(fixture.persisted.at(-1)).toEqual(fixture.messages)
	})

	it("restores interleaved tagged command cards from the persisted transcript", async () => {
		const fixture = createTask([
			{ ts: 100, type: "ask", ask: "command", text: "same command" },
			{ ts: 101, type: "ask", ask: "command", text: "same command" },
		])
		await fixture.output("A preview", true, "100")
		await fixture.output("B preview", true, "101")
		await Task.prototype.say.call(fixture.task, "text", "unrelated", undefined, undefined, undefined, undefined, {
			isNonInteractive: true,
		})
		await fixture.output("A final", false, "100")
		await fixture.output("B final", false, "101")
		const reloaded = JSON.parse(JSON.stringify(fixture.persisted.at(-1))) as AlphaMessage[]
		const cards = consolidateCommands(reloaded).filter(({ type, ask }) => type === "ask" && ask === "command")

		expect(cards.map(({ ts, text }) => [ts, text])).toEqual([
			[100, "same command\nOutput:A final"],
			[101, "same command\nOutput:B final"],
		])
		expect(reloaded.filter(({ say }) => say === "command_output")).toHaveLength(2)
		expect(reloaded.filter(({ say }) => say === "command_output").every(({ partial }) => partial === false)).toBe(
			true,
		)
		expect(reloaded.find(({ text }) => text === "unrelated")).toBeDefined()
	})

	it("keeps same-clock command output rows unique without moving input ownership", async () => {
		const fixture = createTask()
		fixture.clock.mockReturnValue(1_000)
		const activeAsk = { type: "followup", ts: 900 }
		Reflect.set(fixture.task, "activeAsk", activeAsk)
		await fixture.output("A preview", true, "1001")
		await fixture.output("B preview", true, "1002")
		const timestamps = fixture.messages.map(({ ts }) => ts)
		await fixture.output("A final", false, "1001")
		await fixture.output("B final", false, "1002")

		expect(timestamps).toEqual([1_000, 1_001])
		expect(fixture.messages.map(({ ts }) => ts)).toEqual(timestamps)
		expect(fixture.messages.map(({ text }) => text)).toEqual(["A final", "B final"])
		expect(fixture.task.lastMessageTs).toBe(900)
		expect(Reflect.get(fixture.task, "activeAsk")).toBe(activeAsk)
		expect(Reflect.get(fixture.task, "askResponse")).toBeUndefined()
	})

	it.each(["tagged-to-legacy", "legacy-to-tagged"] as const)(
		"does not merge output across the %s identity boundary",
		async (direction) => {
			const previous = partialOutput(42, "previous stream", direction === "tagged-to-legacy" ? "1001" : undefined)
			const incomingId = direction === "legacy-to-tagged" ? "1002" : undefined
			const fixture = createTask([previous])
			await fixture.output("new stream", true, incomingId)
			await fixture.output("new stream final", false, incomingId)

			expect(fixture.messages).toHaveLength(2)
			expect(fixture.messages[0]).toEqual(previous)
			expect(fixture.messages[1]).toMatchObject({ text: "new stream final", partial: false })
			expect(fixture.messages[1].commandExecutionId).toBe(incomingId)
			expect(fixture.created).toHaveLength(1)
			expect(fixture.updated).toHaveLength(1)
			expect(fixture.persisted.at(-1)).toEqual(fixture.messages)
		},
	)

	it("retains tail-only updates for older output without a command identity", async () => {
		const older = partialOutput(41, "older legacy row")
		const fixture = createTask([older, partialOutput(42, "current legacy row")])
		await fixture.output("current preview", true)
		await fixture.output("current final", false)

		expect(fixture.messages).toHaveLength(2)
		expect(fixture.messages[0]).toEqual(older)
		expect(fixture.messages[1]).toMatchObject({ ts: 42, text: "current final", partial: false })
		expect(fixture.messages[1]).not.toHaveProperty("commandExecutionId")
		expect(fixture.created).toEqual([])
		expect(fixture.updated).toHaveLength(2)
		expect(fixture.persisted.at(-1)).toEqual(fixture.messages)
	})

	it("preserves ordinary assistant text update and freshness behavior", async () => {
		const fixture = createTask([{ ts: 42, type: "say", say: "text", text: "first", partial: true }])
		await Task.prototype.say.call(fixture.task, "text", "preview", undefined, true)
		await Task.prototype.say.call(fixture.task, "text", "final", undefined, false)

		expect(fixture.messages).toEqual([
			expect.objectContaining({ ts: 42, say: "text", text: "final", partial: false }),
		])
		expect(fixture.messages[0]).not.toHaveProperty("commandExecutionId")
		expect(fixture.created).toEqual([])
		expect(fixture.updated).toHaveLength(2)
		expect(fixture.task.lastMessageTs).toBe(42)
		expect(Reflect.get(fixture.task, "currentAssistantResponseMessageTs")).toBe(42)
		expect(fixture.persisted.at(-1)).toEqual(fixture.messages)
	})

	it("does not rewind a newer interactive timestamp when finalizing an earlier command row", async () => {
		const later: AlphaMessage = { ...partialOutput(2_000, "B completed", "1002"), partial: false }
		const fixture = createTask([partialOutput(1_000, "A pending", "1001"), later])
		fixture.task.lastMessageTs = 2_000
		await fixture.output("A completed", false, "1001", { isNonInteractive: false })

		expect(fixture.task.lastMessageTs).toBe(2_000)
		expect(fixture.messages).toHaveLength(2)
		expect(fixture.messages[0]).toMatchObject({
			ts: 1_000,
			text: "A completed",
			partial: false,
			commandExecutionId: "1001",
		})
		expect(fixture.messages[1]).toEqual(later)
		expect(fixture.created).toEqual([])
		expect(fixture.persisted.at(-1)).toEqual(fixture.messages)
	})

	it("joins completed-row persistence before publication and acknowledgement", async () => {
		const fixture = createTask([partialOutput(41, "A preview", "1001"), partialOutput(42, "B preview", "1002")])
		const saveEntered = barrier()
		const finishSave = barrier()
		const updateEntered = barrier()
		const finishUpdate = barrier()
		fixture.saveAlphaMessages.mockImplementationOnce(async () => {
			fixture.events.push("save:start")
			saveEntered.release()
			await finishSave.promise
			fixture.persisted.push(structuredClone(fixture.messages))
			fixture.events.push("save:done")
			return true
		})
		fixture.updateAlphaMessage.mockImplementationOnce(async (message) => {
			fixture.events.push("update:start")
			fixture.updated.push(structuredClone(message))
			updateEntered.release()
			await finishUpdate.promise
			fixture.events.push("update:done")
		})
		let acknowledged = false
		const completion = fixture.output("A final", false, "1001").then(() => (acknowledged = true))
		try {
			await saveEntered.promise
			expect(fixture.messages[0]).toMatchObject({
				ts: 41,
				text: "A final",
				partial: false,
				commandExecutionId: "1001",
			})
			expect(fixture.messages[1]).toMatchObject({
				ts: 42,
				text: "B preview",
				partial: true,
				commandExecutionId: "1002",
			})
			expect(fixture.updateAlphaMessage).not.toHaveBeenCalled()
			expect(acknowledged).toBe(false)
			finishSave.release()
			await updateEntered.promise
			expect(fixture.persisted).toEqual([fixture.messages])
			expect(fixture.updated).toEqual([fixture.messages[0]])
			expect(fixture.events).toEqual(["save:start", "save:done", "update:start"])
			expect(acknowledged).toBe(false)
			finishUpdate.release()
			await completion
			expect(acknowledged).toBe(true)
			expect(fixture.events).toEqual(["save:start", "save:done", "update:start", "update:done"])
			expect(fixture.task.lastMessageTs).toBe(900)
		} finally {
			finishSave.release()
			finishUpdate.release()
			await completion
		}
	})

	it("rejects an aborted task before mutating correlated output", async () => {
		const fixture = createTask([partialOutput(42, "existing", "1001")])
		fixture.task.abort = true
		await expect(fixture.output("late", false, "1001")).rejects.toThrow("aborted")

		expect(fixture.messages).toEqual([partialOutput(42, "existing", "1001")])
		expect(fixture.created).toEqual([])
		expect(fixture.updated).toEqual([])
		expect(fixture.persisted).toEqual([])
	})

	it("ignores an obsolete preview epoch before mutating correlated output", async () => {
		const fixture = createTask([partialOutput(42, "existing", "1001")])
		fixture.previewCurrent.mockReturnValue(false)
		await expect(fixture.output("obsolete", true, "1001", { previewEpoch: 7 })).resolves.toBeUndefined()

		expect(fixture.previewCurrent).toHaveBeenCalledExactlyOnceWith(7)
		expect(fixture.messages).toEqual([partialOutput(42, "existing", "1001")])
		expect(fixture.created).toEqual([])
		expect(fixture.updated).toEqual([])
		expect(fixture.persisted).toEqual([])
		expect(fixture.task.lastMessageTs).toBe(900)
	})
})

describe("Task UI message identity reservation", () => {
	it.each([undefined, true, false])(
		"gives an ordinary ask a distinct identity after same-clock output (partial=%s)",
		async (partial) => {
			const fixture = createTask()
			fixture.clock.mockReturnValue(1_000)
			await fixture.output("command completed", false, "1001")
			if (partial === true) {
				await expect(Task.prototype.ask.call(fixture.task, "followup", "Continue?", partial)).rejects.toThrow(
					"new partial",
				)
			} else {
				answerNextAsk(fixture, "noButtonClicked")
				await Task.prototype.ask.call(fixture.task, "followup", "Continue?", partial)
			}

			expect(fixture.messages.map(({ ts }) => ts)).toEqual([1_000, 1_001])
			expect(fixture.messages[0]).toMatchObject({ say: "command_output", text: "command completed" })
			expect(fixture.messages[1]).toMatchObject({ type: "ask", ask: "followup", text: "Continue?" })
			expect(fixture.task.lastMessageTs).toBe(1_001)
		},
	)

	it.each([undefined, true, false])(
		"gives an ordinary say a distinct identity after same-clock output (partial=%s)",
		async (partial) => {
			const fixture = createTask()
			fixture.clock.mockReturnValue(1_000)
			await fixture.output("command completed", false, "1001")
			await Task.prototype.say.call(fixture.task, "text", "assistant text", undefined, partial)

			expect(fixture.messages.map(({ ts }) => ts)).toEqual([1_000, 1_001])
			expect(fixture.messages[0]).toMatchObject({ say: "command_output", text: "command completed" })
			expect(fixture.messages[1]).toMatchObject({ say: "text", text: "assistant text" })
			expect(fixture.task.lastMessageTs).toBe(1_001)
		},
	)

	it("creates a distinct completion row after noninteractive output in the same clock tick", async () => {
		const fixture = createTask()
		fixture.clock.mockReturnValue(1_000)
		await fixture.output("command completed", false, "1001")
		await Task.prototype.presentCompletionResult.call(fixture.task, "Answer")

		expect(fixture.messages.map(({ ts, say, text }) => [ts, say, text])).toEqual([
			[1_000, "command_output", "command completed"],
			[1_001, "completion_result", "Answer"],
		])
		expect(fixture.task.lastMessageTs).toBe(1_001)
		expect(fixture.created.map(({ ts }) => ts)).toEqual([1_000, 1_001])
	})

	it("reserves a completion identity while its storage commit is suspended", async () => {
		const fixture = createTask()
		fixture.clock.mockReturnValue(1_000)
		const storageEntered = barrier()
		const finishStorage = barrier()
		const save = Reflect.get(fixture.task, "enqueueAlphaMessagesSave") as ReturnType<typeof vi.fn>
		save.mockImplementationOnce(async (snapshot: () => AlphaMessage[], onPersisted: () => void) => {
			storageEntered.release()
			await finishStorage.promise
			fixture.persisted.push(structuredClone(snapshot()))
			onPersisted()
			return true
		})
		const completion = Task.prototype.presentCompletionResult.call(fixture.task, "Answer")
		try {
			await storageEntered.promise
			expect(fixture.messages).toEqual([])
			await fixture.output("output during commit", false, "1001")
			expect(fixture.messages[0]).toMatchObject({
				ts: 1_001,
				say: "command_output",
				text: "output during commit",
			})
			finishStorage.release()
			await completion
			expect(new Set(fixture.messages.map(({ ts }) => ts)).size).toBe(2)
			expect(fixture.messages.map(({ ts, say }) => [ts, say])).toEqual([
				[1_001, "command_output"],
				[1_000, "completion_result"],
			])
		} finally {
			finishStorage.release()
			await completion
		}
	})

	it("seeds new row identity from the whole hydrated transcript rather than the tail", async () => {
		const fixture = createTask([
			{ ts: 9_000, type: "say", say: "text", text: "imported" },
			{ ts: 50, type: "say", say: "text", text: "older tail" },
		])
		fixture.clock.mockReturnValue(1_000)
		await fixture.output("new", false, "1001")

		expect(fixture.messages.map(({ ts }) => ts)).toEqual([9_000, 50, 9_001])
		expect(fixture.task.lastMessageTs).toBe(900)
	})

	it("retains hydrated identity bounds when a lower imported row is observed first", async () => {
		const imported: AlphaMessage = { ts: 9_000, type: "say", say: "text", text: "hydrated row" }
		const fixture = createTask([imported])
		fixture.clock.mockReturnValue(1_000)
		await Task.prototype["addToAlphaMessages"].call(fixture.task, {
			ts: 50,
			type: "say",
			say: "text",
			text: "caller-owned row",
		})
		await fixture.output("new", false, "1001")

		expect(fixture.messages.map(({ ts }) => ts)).toEqual([9_000, 50, 9_001])
		expect(fixture.messages[0]).toEqual(imported)
	})

	it("refreshes replaced transcript bounds without reusing an earlier reserved identity", async () => {
		const fixture = createTask()
		fixture.clock.mockReturnValue(1_000)
		fixture.saveAlphaMessages.mockImplementation(async () => {
			fixture.persisted.push(structuredClone(fixture.task.alphaMessages))
			return true
		})
		await fixture.output("first", false, "1001")
		await Task.prototype.overwriteAlphaMessages.call(fixture.task, [
			{ ts: 9_000, type: "say", say: "text", text: "replacement" },
		])
		await fixture.output("second", false, "1002")
		expect(fixture.task.alphaMessages.map(({ ts }) => ts)).toEqual([9_000, 9_001])
		await Task.prototype.overwriteAlphaMessages.call(fixture.task, [
			{ ts: 50, type: "say", say: "text", text: "older replacement" },
		])
		await fixture.output("third", false, "1003")

		expect(fixture.task.alphaMessages.map(({ ts }) => ts)).toEqual([50, 9_002])
		expect(fixture.task.lastMessageTs).toBe(900)
		expect(fixture.persisted.at(-1)).toEqual(fixture.task.alphaMessages)
	})

	it("gives a forced managed terminal row a distinct same-clock identity", async () => {
		const previous: AlphaMessage = { ts: 1_000, type: "say", say: "command_output", text: "retained output" }
		const fixture = createTask([previous])
		fixture.clock.mockReturnValue(1_000)
		Reflect.set(fixture.task, "taskKind", "subagent")
		await Task.prototype.finalizeSubagentHistory.call(fixture.task, "completed", "Managed done", "completed")

		expect(fixture.messages).toEqual([
			previous,
			expect.objectContaining({
				ts: 1_001,
				type: "say",
				say: "completion_result",
				text: "Managed done",
				partial: false,
			}),
		])
		expect(fixture.persisted.at(-1)).toEqual(fixture.messages)
		expect(Reflect.get(fixture.task, "initialStatus")).toBe("completed")
		expect(fixture.task.lastMessageTs).toBe(900)
	})
})

describe("Task approved command presentation (new API controls)", () => {
	it("persists an answered redacted command without changing an unrelated active ask", async () => {
		const fixture = createTask()
		const activeAsk = { type: "followup", ts: 900, toolCallId: "question-call" }
		Reflect.set(fixture.task, "activeAsk", activeAsk)
		Reflect.set(fixture.task, "taskKind", "subagent")
		Reflect.set(fixture.task, "subagentRole", "worker")
		const progress: ToolProgressStatus = { icon: "terminal", text: "Approved" }
		const id = await Task.prototype.presentApprovedCommand.call(
			fixture.task,
			`rg proof ${fixture.task.cwd}/src`,
			progress,
		)

		expect(fixture.messages).toEqual([
			expect.objectContaining({
				ts: Number(id),
				type: "ask",
				ask: "command",
				text: "rg proof ./src",
				isAnswered: true,
				progressStatus: progress,
			}),
		])
		expect(fixture.created).toEqual(fixture.messages)
		expect(fixture.persisted).toEqual([fixture.messages])
		expect(fixture.events).toEqual(["created", "save"])
		expect(Reflect.get(fixture.task, "activeAsk")).toBe(activeAsk)
		expect(Reflect.get(fixture.task, "askResponse")).toBeUndefined()
		expect(fixture.task.lastMessageTs).toBe(900)
		expect(fixture.task.apiConversationHistory).toEqual([])
	})

	it("allocates distinct same-clock presentations and a subsequent interactive command row", async () => {
		const fixture = createTask()
		fixture.clock.mockReturnValue(1_000)
		const first = await Task.prototype.presentApprovedCommand.call(fixture.task, "rg first src")
		const second = await Task.prototype.presentApprovedCommand.call(fixture.task, "rg second src")
		expect(fixture.task.lastMessageTs).toBe(900)
		answerNextAsk(fixture)
		await Task.prototype.ask.call(fixture.task, "command", "rg third src", undefined, undefined, undefined, true)

		expect([first, second]).toEqual(["1000", "1001"])
		expect(fixture.messages.map(({ ts }) => ts)).toEqual([1_000, 1_001, 1_002])
		expect(fixture.messages.slice(0, 2).every(({ isAnswered }) => isAnswered === true)).toBe(true)
		expect(fixture.task.lastMessageTs).toBe(1_002)
	})

	it("rejects cancellation before an approved presentation has side effects", async () => {
		const fixture = createTask()
		fixture.task.abort = true
		await expect(Task.prototype.presentApprovedCommand.call(fixture.task, "rg proof src")).rejects.toThrow(
			"aborted",
		)
		expect(fixture.messages).toEqual([])
		expect(fixture.created).toEqual([])
		expect(fixture.persisted).toEqual([])
		expect(fixture.task.lastMessageTs).toBe(900)
	})

	it("rejects a failed approved presentation save without returning a row receipt", async () => {
		const fixture = createTask()
		fixture.saveAlphaMessages.mockResolvedValueOnce(false)
		await expect(Task.prototype.presentApprovedCommand.call(fixture.task, "rg proof src")).rejects.toThrow(
			"Unable to persist the approved command presentation.",
		)

		expect(fixture.messages).toHaveLength(1)
		expect(fixture.created).toEqual(fixture.messages)
		expect(fixture.persisted).toEqual([])
		expect(fixture.saveAlphaMessages).toHaveBeenCalledTimes(1)
		expect(fixture.task.lastMessageTs).toBe(900)
	})

	it("preserves an approved presentation storage exception without returning a row receipt", async () => {
		const fixture = createTask()
		const failure = new Error("controlled storage failure")
		fixture.saveAlphaMessages.mockRejectedValueOnce(failure)
		await expect(Task.prototype.presentApprovedCommand.call(fixture.task, "rg proof src")).rejects.toBe(failure)

		expect(fixture.messages).toHaveLength(1)
		expect(fixture.created).toEqual(fixture.messages)
		expect(fixture.persisted).toEqual([])
		expect(fixture.saveAlphaMessages).toHaveBeenCalledTimes(1)
		expect(fixture.task.lastMessageTs).toBe(900)
	})

	it("does not return an approved presentation receipt when cancellation wins during publication", async () => {
		const fixture = createTask()
		const published = barrier()
		const finishPublication = barrier()
		const publish = fixture.publishAlphaMessageCreated.getMockImplementation()!
		fixture.publishAlphaMessageCreated.mockImplementationOnce(async (message, stateUpdate) => {
			await publish(message, stateUpdate)
			published.release()
			await finishPublication.promise
		})
		const presentation = Task.prototype.presentApprovedCommand.call(fixture.task, "rg proof src")
		const outcome = presentation.then(
			() => "receipt",
			(error: Error) => error.message,
		)
		try {
			await published.promise
			fixture.task.abort = true
			finishPublication.release()
			expect(await outcome).toContain("aborted")
			expect(fixture.messages).toHaveLength(1)
			expect(fixture.persisted).toEqual([fixture.messages])
			expect(fixture.task.lastMessageTs).toBe(900)
		} finally {
			finishPublication.release()
			await outcome
		}
	})
})

describe("Task command approval row receipts", () => {
	it("reports the existing answered command row from the actual automatic approval policy", async () => {
		const fixture = createTask()
		const provider = { getState: vi.fn(async () => ({ allowedCommands: ["rg"], deniedCommands: [] })) }
		Reflect.set(fixture.task, "providerRef", { deref: () => provider })
		Reflect.set(fixture.task, "approvalStateForAsk", Task.prototype["approvalStateForAsk"])
		const publish = fixture.publishAlphaMessageCreated.getMockImplementation()!
		fixture.publishAlphaMessageCreated.mockImplementationOnce(async (message, stateUpdate) => {
			await publish(message, stateUpdate)
			if (!message.isAnswered) fixture.task.handleWebviewAskResponse("noButtonClicked")
		})
		const receipt = vi.fn()
		await expect(
			Task.prototype.ask.call(
				fixture.task,
				"command",
				"rg proof src",
				undefined,
				undefined,
				undefined,
				undefined,
				undefined,
				receipt,
			),
		).resolves.toEqual({ response: "yesButtonClicked", text: undefined, images: undefined })

		expect(fixture.messages).toHaveLength(1)
		expect(fixture.messages[0]).toMatchObject({ ask: "command", text: "rg proof src", isAnswered: true })
		expect(fixture.persisted).toEqual([fixture.messages])
		expect(receipt).toHaveBeenCalledExactlyOnceWith(fixture.messages[0].ts.toString())
	})

	it("reports the stable identity of an accepted promoted command partial", async () => {
		const fixture = createTask()
		fixture.clock.mockReturnValue(1_000)
		await expect(Task.prototype.ask.call(fixture.task, "command", "preview", true)).rejects.toThrow("new partial")
		const originalTimestamp = fixture.messages[0].ts
		const update = fixture.updateAlphaMessage.getMockImplementation()!
		fixture.updateAlphaMessage.mockImplementationOnce((message) => {
			const publication = update(message)
			expect(
				fixture.task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, undefined, message.ts),
			).toBe(true)
			return publication
		})
		const receipt = vi.fn()
		await Task.prototype.ask.call(
			fixture.task,
			"command",
			"rg proof src",
			false,
			undefined,
			undefined,
			true,
			undefined,
			receipt,
		)

		expect(fixture.messages).toHaveLength(1)
		expect(fixture.messages[0]).toMatchObject({
			ts: originalTimestamp,
			ask: "command",
			text: "rg proof src",
			partial: false,
		})
		expect(fixture.created).toHaveLength(1)
		expect(receipt).toHaveBeenCalledExactlyOnceWith(originalTimestamp.toString())
	})

	it("returns the accepted command's captured row identity after interleaved output", async () => {
		const fixture = createTask()
		fixture.clock.mockReturnValue(1_000)
		const rowPublished = barrier()
		const finishPublication = barrier()
		const publish = fixture.publishAlphaMessageCreated.getMockImplementation()!
		fixture.publishAlphaMessageCreated.mockImplementationOnce(async (message, stateUpdate) => {
			await publish(message, stateUpdate)
			rowPublished.release()
			await finishPublication.promise
		})
		const receipt = vi.fn()
		const approval = Task.prototype.ask.call(
			fixture.task,
			"command",
			"rg proof src",
			undefined,
			undefined,
			undefined,
			true,
			undefined,
			receipt,
		)
		try {
			await rowPublished.promise
			const approvalTs = fixture.messages[0].ts
			await fixture.output("other command output", true, "different-command")
			expect(fixture.task.lastMessageTs).toBe(approvalTs)
			expect(
				fixture.task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, undefined, approvalTs),
			).toBe(true)
			finishPublication.release()
			await expect(approval).resolves.toEqual({
				response: "yesButtonClicked",
				text: undefined,
				images: undefined,
			})
			expect(receipt).toHaveBeenCalledExactlyOnceWith(approvalTs.toString())
			expect(fixture.messages.at(-1)?.ts).not.toBe(approvalTs)
			expect(Reflect.get(fixture.task, "activeAsk")).toBeUndefined()
		} finally {
			finishPublication.release()
			Reflect.set(fixture.task, "askResponse", "yesButtonClicked")
			await approval.catch(() => {})
		}
	})

	it.each(["noButtonClicked", "messageResponse"] as const)(
		"does not issue a command receipt for %s",
		async (response) => {
			const fixture = createTask()
			answerNextAsk(fixture, response)
			const receipt = vi.fn()
			await expect(
				Task.prototype.ask.call(
					fixture.task,
					"command",
					"rg proof src",
					undefined,
					undefined,
					undefined,
					true,
					undefined,
					receipt,
				),
			).resolves.toMatchObject({ response })
			expect(receipt).not.toHaveBeenCalled()
		},
	)

	it.each(["abort", "supersede"] as const)("does not issue an accepted receipt after %s wins", async (action) => {
		const fixture = createTask()
		const publish = fixture.publishAlphaMessageCreated.getMockImplementation()!
		fixture.publishAlphaMessageCreated.mockImplementationOnce(async (message, stateUpdate) => {
			await publish(message, stateUpdate)
			expect(
				fixture.task.handleWebviewAskResponse("yesButtonClicked", undefined, undefined, undefined, message.ts),
			).toBe(true)
			if (action === "abort") fixture.task.abort = true
			else fixture.task.lastMessageTs = message.ts + 1
		})
		const receipt = vi.fn()
		await expect(
			Task.prototype.ask.call(
				fixture.task,
				"command",
				"rg proof src",
				undefined,
				undefined,
				undefined,
				true,
				undefined,
				receipt,
			),
		).rejects.toThrow(action === "abort" ? "aborted" : "superseded")
		expect(receipt).not.toHaveBeenCalled()
		expect(Reflect.get(fixture.task, "activeAsk")).toBeUndefined()
	})

	it("forwards a typed command receipt while preserving the strict approval decision", async () => {
		const fixture = createTask()
		answerNextAsk(fixture)
		const request = commandApproval(fixture.task.taskId)
		const receipt = vi.fn()
		await expect(
			Task.prototype.requestToolApproval.call(fixture.task, request, request.description, receipt),
		).resolves.toEqual({ decision: "approve_once" })
		expect(fixture.messages).toHaveLength(1)
		expect(fixture.messages[0]).toMatchObject({
			ask: "command",
			isAnswered: true,
			toolApprovalRequest: { requestId: request.requestId },
		})
		expect(receipt).toHaveBeenCalledExactlyOnceWith(fixture.messages[0].ts.toString())
		expect(Reflect.get(fixture.task, "activeToolApprovalRequest")).toBeUndefined()
	})

	it("does not mint a row receipt for a reviewer-only command approval", async () => {
		const fixture = createTask()
		Reflect.set(
			fixture.task,
			"reviewToolApproval",
			vi.fn(async () => ({ decision: "approve_once" })),
		)
		const request = commandApproval(fixture.task.taskId)
		const receipt = vi.fn()
		await expect(
			Task.prototype.requestToolApproval.call(fixture.task, request, request.description, receipt),
		).resolves.toEqual({ decision: "approve_once" })
		expect(receipt).not.toHaveBeenCalled()
		expect(fixture.messages).toEqual([])
		expect(fixture.persisted).toEqual([])
	})

	it.each(["no-observer", "non-command"] as const)(
		"preserves the existing seven ask arguments for %s typed approval",
		async (kind) => {
			const fixture = createTask()
			const request = commandApproval(fixture.task.taskId)
			if (kind === "non-command") {
				Object.assign(request, { askType: "tool", toolName: "read_file", description: "Read src/main.ts" })
			}
			const ask = vi.fn(async () => ({ response: "yesButtonClicked" as const }))
			Reflect.set(fixture.task, "ask", ask)
			const receipt = vi.fn()
			await Task.prototype.requestToolApproval.call(
				fixture.task,
				request,
				request.description,
				kind === "non-command" ? receipt : undefined,
			)
			expect(ask).toHaveBeenCalledTimes(1)
			expect(ask.mock.calls[0]).toHaveLength(7)
			expect(receipt).not.toHaveBeenCalled()
		},
	)
})
