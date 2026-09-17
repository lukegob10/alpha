import { beforeEach, describe, expect, it, vi } from "vitest"

import { presentAssistantMessage } from "../presentAssistantMessage"
import type { Task } from "../../task/Task"
import { validateToolUse } from "../../tools/validateToolUse"
import { customToolRegistry } from "@alpha-code/core"
import type { CustomToolDefinition } from "@alpha-code/types"

type PreviewBlock = {
	type: "text" | "tool_use" | "mcp_tool_use"
	id?: string
	name?: string
	params?: Record<string, unknown>
	nativeArgs?: Record<string, unknown>
	partial?: boolean
	content?: string
	serverName?: string
	toolName?: string
	arguments?: Record<string, unknown>
}

type SayOptions = {
	previewEpoch?: number
}

type SayImplementation = (
	type: string,
	text?: string,
	images?: string[],
	partial?: boolean,
	checkpoint?: Record<string, unknown>,
	progressStatus?: unknown,
	options?: SayOptions,
) => Promise<undefined>

type PresentationTask = {
	taskId: string
	instanceId: string
	abort: boolean
	abandoned?: boolean
	presentAssistantMessageLocked: boolean
	presentAssistantMessageHasPendingUpdates: boolean
	presentAssistantMessageLockOwner?: unknown
	currentStreamingContentIndex: number
	assistantMessageContent: PreviewBlock[]
	userMessageContent: unknown[]
	userMessageContentReady: boolean
	didCompleteReadingStream: boolean
	didRejectTool: boolean
	consecutiveMistakeCount: number
	api: {
		getModel: ReturnType<typeof vi.fn>
	}
	providerRef: {
		deref: ReturnType<typeof vi.fn>
	}
	getTaskMode: ReturnType<typeof vi.fn>
	getTaskToolDenialReason: ReturnType<typeof vi.fn>
	recordToolUsage: ReturnType<typeof vi.fn>
	recordToolError: ReturnType<typeof vi.fn>
	toolRepetitionDetector: {
		check: ReturnType<typeof vi.fn>
	}
	say: ReturnType<typeof vi.fn<SayImplementation>>
	ask: ReturnType<typeof vi.fn>
	pushToolResultToUserContent: ReturnType<typeof vi.fn>
	checkpointSave: ReturnType<typeof vi.fn>
	getTaskCancellationSignal: ReturnType<typeof vi.fn>
	isStreamingPreviewEpochCurrent: ReturnType<typeof vi.fn<(epoch: number) => boolean>>
}

const { readFileHandle, mcpToolHandle, customToolExecute } = vi.hoisted(() => ({
	readFileHandle: vi.fn(),
	mcpToolHandle: vi.fn(),
	customToolExecute: vi.fn(),
}))

vi.mock("../../task/Task")
vi.mock("../../tools/ReadFileTool", () => ({
	readFileTool: {
		handle: readFileHandle,
		getReadFileToolDescription: vi.fn(() => "[read_file]"),
	},
}))
vi.mock("../../tools/UseMcpToolTool", () => ({
	useMcpToolTool: {
		handle: mcpToolHandle,
	},
}))
vi.mock("../../tools/validateToolUse", () => ({
	validateToolUse: vi.fn(),
	isValidToolName: vi.fn(() => true),
}))
vi.mock("@alpha-code/core", () => ({
	customToolRegistry: {
		has: vi.fn(),
		get: vi.fn(),
	},
}))
vi.mock("@alpha-code/telemetry", () => ({
	TelemetryService: {
		instance: {
			captureToolUsage: vi.fn(),
			captureConsecutiveMistakeError: vi.fn(),
			captureException: vi.fn(),
			captureEvent: vi.fn(),
		},
	},
}))

describe("presentAssistantMessage preview", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		readFileHandle.mockResolvedValue(undefined)
		mcpToolHandle.mockResolvedValue(undefined)
		customToolExecute.mockResolvedValue("custom result")
		vi.mocked(validateToolUse).mockImplementation(() => undefined)
		vi.mocked(customToolRegistry.has).mockReturnValue(false)
		vi.mocked(customToolRegistry.get).mockReturnValue(undefined)
	})

	it.each([
		[
			"a complete native tool",
			{
				type: "tool_use",
				id: "call-read-file",
				name: "read_file",
				params: { path: "README.md" },
				nativeArgs: { path: "README.md" },
				partial: false,
			},
		],
		[
			"a partial native tool",
			{
				type: "tool_use",
				id: "call-partial",
				name: "read_file",
				params: { path: "README.md" },
				nativeArgs: { path: "README.md" },
				partial: true,
			},
		],
		[
			"an unknown native tool",
			{
				type: "tool_use",
				id: "call-unknown",
				name: "unknown_preview_tool",
				params: {},
				nativeArgs: {},
				partial: false,
			},
		],
		[
			"a native tool with no id",
			{
				type: "tool_use",
				name: "read_file",
				params: { path: "README.md" },
				nativeArgs: { path: "README.md" },
				partial: false,
			},
		],
		[
			"a native MCP tool",
			{
				type: "mcp_tool_use",
				id: "call-mcp",
				name: "mcp_server_preview_tool",
				serverName: "server",
				toolName: "preview_tool",
				arguments: { value: "preview" },
				partial: false,
			},
		],
		[
			"a native custom tool",
			{
				type: "tool_use",
				id: "call-custom",
				name: "custom_preview_tool",
				params: { value: "preview" },
				nativeArgs: { value: "preview" },
				partial: false,
			},
		],
	] as const)("does not execute %s or read policy state", async (_label, block) => {
		if (block.name === "custom_preview_tool") {
			vi.mocked(customToolRegistry.has).mockReturnValue(true)
			const customTool: CustomToolDefinition = {
				name: "custom_preview_tool",
				description: "Preview custom tool",
				execute: customToolExecute,
			}
			vi.mocked(customToolRegistry.get).mockReturnValue(customTool)
		}

		const task = createTask([block])

		await presentAssistantMessage(task as unknown as Task)

		expect(readFileHandle).not.toHaveBeenCalled()
		expect(mcpToolHandle).not.toHaveBeenCalled()
		expect(customToolExecute).not.toHaveBeenCalled()
		expect(task.say).not.toHaveBeenCalled()
		expect(task.ask).not.toHaveBeenCalled()
		expect(task.pushToolResultToUserContent).not.toHaveBeenCalled()
		expect(task.checkpointSave).not.toHaveBeenCalled()
		expect(task.recordToolUsage).not.toHaveBeenCalled()
		expect(task.recordToolError).not.toHaveBeenCalled()
		expect(task.getTaskMode).not.toHaveBeenCalled()
		expect(task.getTaskToolDenialReason).not.toHaveBeenCalled()
		expect(task.api.getModel).not.toHaveBeenCalled()
		expect(task.providerRef.deref).not.toHaveBeenCalled()
		expect(validateToolUse).not.toHaveBeenCalled()
		expect(task.userMessageContent).toEqual([])
		expect(task.currentStreamingContentIndex).toBe(1)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("presents text after skipped tools and preserves partial/final order for late updates", async () => {
		const task = createTask(
			[createNativeToolBlock("call-before-text"), { type: "text", content: "draft", partial: true }],
			false,
		)

		await presentAssistantMessage(task as unknown as Task)

		expect(textCalls(task)).toEqual([{ text: "draft", partial: true }])
		expect(task.currentStreamingContentIndex).toBe(1)

		task.assistantMessageContent[1] = { type: "text", content: "final", partial: false }
		task.assistantMessageContent.push({ type: "text", content: "after", partial: false })
		task.didCompleteReadingStream = true

		await presentAssistantMessage(task as unknown as Task)

		expect(textCalls(task)).toEqual([
			{ text: "draft", partial: true },
			{ text: "final", partial: false },
			{ text: "after", partial: false },
		])
		expect(readFileHandle).not.toHaveBeenCalled()
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("drains an update queued at the final lock boundary", async () => {
		const task = createTask([{ type: "text", content: "draft", partial: true }], false)
		let queuedPresentation: Promise<void> | undefined

		task.say.mockImplementation(async (type, _text, _images, partial) => {
			if (type === "text" && partial && !queuedPresentation) {
				task.assistantMessageContent[0] = { type: "text", content: "final", partial: false }
				task.didCompleteReadingStream = true
				queuedPresentation = presentAssistantMessage(task as unknown as Task)
			}
			return undefined
		})

		await presentAssistantMessage(task as unknown as Task)
		await queuedPresentation

		expect(textCalls(task)).toEqual([
			{ text: "draft", partial: true },
			{ text: "final", partial: false },
		])
		expect(task.presentAssistantMessageHasPendingUpdates).toBe(false)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("drains a final update queued at the lock-owner release boundary", async () => {
		const task = createTask([{ type: "text", content: "streaming", partial: true }], false)
		let pendingUpdate = false
		let armBoundaryUpdate = false
		let scheduledBoundaryUpdate = false
		Object.defineProperty(task, "presentAssistantMessageHasPendingUpdates", {
			configurable: true,
			get() {
				if (armBoundaryUpdate && !scheduledBoundaryUpdate) {
					scheduledBoundaryUpdate = true
					queueMicrotask(() => {
						task.assistantMessageContent[0].partial = false
						task.assistantMessageContent[0].content = "complete"
						task.didCompleteReadingStream = true
						void presentAssistantMessage(task as unknown as Task)
					})
				}
				return pendingUpdate
			},
			set(value: boolean) {
				pendingUpdate = value
			},
		})
		task.say.mockImplementation(async () => {
			armBoundaryUpdate = true
			return undefined
		})

		await presentAssistantMessage(task as unknown as Task)

		expect(task.say).toHaveBeenCalledTimes(2)
		expect(task.say).toHaveBeenLastCalledWith("text", "complete", undefined, false)
		expect(task.currentStreamingContentIndex).toBe(1)
		expect(task.userMessageContentReady).toBe(true)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("serializes concurrent text presentation behind one lock", async () => {
		const task = createTask(
			[
				{ type: "text", content: "first", partial: false },
				{ type: "text", content: "second", partial: false },
			],
			true,
		)
		const firstStarted = deferred()
		const releaseFirst = deferred()
		let activeRenders = 0
		let maxActiveRenders = 0

		task.say.mockImplementation(async (type, text) => {
			activeRenders += 1
			maxActiveRenders = Math.max(maxActiveRenders, activeRenders)
			if (type === "text" && text === "first") {
				firstStarted.resolve()
				await releaseFirst.promise
			}
			activeRenders -= 1
			return undefined
		})

		const firstPresentation = presentAssistantMessage(task as unknown as Task)
		await firstStarted.promise
		const concurrentPresentation = presentAssistantMessage(task as unknown as Task)
		expect(task.presentAssistantMessageLocked).toBe(true)
		expect(task.presentAssistantMessageHasPendingUpdates).toBe(true)

		releaseFirst.resolve()
		await Promise.all([firstPresentation, concurrentPresentation])

		expect(textCalls(task)).toEqual([
			{ text: "first", partial: false },
			{ text: "second", partial: false },
		])
		expect(maxActiveRenders).toBe(1)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("ignores a stale preview epoch before entry", async () => {
		const task = createTask([{ type: "text", content: "stale", partial: false }])
		task.isStreamingPreviewEpochCurrent.mockReturnValue(false)

		await expect(
			presentAssistantMessage(task as unknown as Task, {
				previewEpoch: 1,
			}),
		).resolves.toBeUndefined()

		expect(task.say).not.toHaveBeenCalled()
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("stops after a preview epoch becomes stale while say is pending", async () => {
		const task = createTask([{ type: "text", content: "old", partial: true }], false)
		const sayStarted = deferred()
		const releaseSay = deferred()
		let currentEpoch = 1
		task.isStreamingPreviewEpochCurrent.mockImplementation((epoch) => epoch === currentEpoch && !task.abort)
		task.say.mockImplementation(async (type) => {
			if (type === "text") {
				sayStarted.resolve()
				await releaseSay.promise
			}
			return undefined
		})

		const presentation = presentAssistantMessage(task as unknown as Task, { previewEpoch: 1 })
		await sayStarted.promise
		task.assistantMessageContent.push({ type: "text", content: "late", partial: false })
		currentEpoch = 2
		releaseSay.resolve()
		await presentation

		expect(textCalls(task)).toEqual([{ text: "old", partial: true }])
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("does not let an old preview epoch release a new owner's lock", async () => {
		const task = createTask([{ type: "text", content: "old", partial: true }], false)
		const oldStarted = deferred()
		const newStarted = deferred()
		const releaseOld = deferred()
		const releaseNew = deferred()
		let currentEpoch = 1
		task.isStreamingPreviewEpochCurrent.mockImplementation((epoch) => epoch === currentEpoch && !task.abort)
		task.say.mockImplementation(async (type, _text, _images, partial, _checkpoint, _progressStatus, options) => {
			if (type !== "text" || !partial || options?.previewEpoch === undefined) return undefined
			if (options.previewEpoch === 1) {
				oldStarted.resolve()
				await releaseOld.promise
			} else if (options.previewEpoch === 2) {
				newStarted.resolve()
				await releaseNew.promise
			}
			return undefined
		})

		const oldPresentation = presentAssistantMessage(task as unknown as Task, { previewEpoch: 1 })
		await oldStarted.promise

		currentEpoch = 2
		task.presentAssistantMessageLocked = false
		task.assistantMessageContent = [{ type: "text", content: "new", partial: true }]
		task.currentStreamingContentIndex = 0
		const newPresentation = presentAssistantMessage(task as unknown as Task, { previewEpoch: 2 })
		await newStarted.promise

		releaseOld.resolve()
		await oldPresentation
		expect(task.presentAssistantMessageLocked).toBe(true)

		releaseNew.resolve()
		await newPresentation
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("ignores cancellation before entry for the cancelled preview epoch", async () => {
		const task = createTask([{ type: "text", content: "cancelled", partial: false }])
		task.abort = true
		task.isStreamingPreviewEpochCurrent.mockReturnValue(false)

		await expect(presentAssistantMessage(task as unknown as Task, { previewEpoch: 1 })).resolves.toBeUndefined()

		expect(task.say).not.toHaveBeenCalled()
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("rejects a default presentation that is already aborted", async () => {
		const task = createTask([{ type: "text", content: "cancelled", partial: false }])
		task.abort = true

		await expect(presentAssistantMessage(task as unknown as Task)).rejects.toThrow("aborted")

		expect(task.say).not.toHaveBeenCalled()
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("stops later text and releases its lock when cancellation arrives while say is pending", async () => {
		const task = createTask([{ type: "text", content: "before cancellation", partial: true }], false)
		const sayStarted = deferred()
		const releaseSay = deferred()
		task.isStreamingPreviewEpochCurrent.mockImplementation((epoch) => epoch === 1 && !task.abort)
		task.say.mockImplementation(async (type) => {
			if (type === "text") {
				sayStarted.resolve()
				await releaseSay.promise
			}
			return undefined
		})

		const presentation = presentAssistantMessage(task as unknown as Task, { previewEpoch: 1 })
		await sayStarted.promise
		task.abort = true
		task.assistantMessageContent.push({ type: "text", content: "after cancellation", partial: false })
		releaseSay.resolve()
		await presentation

		expect(textCalls(task)).toEqual([{ text: "before cancellation", partial: true }])
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("rejects and releases its lock when default presentation is aborted while say is pending", async () => {
		const task = createTask([{ type: "text", content: "before cancellation", partial: true }], false)
		const sayStarted = deferred()
		const releaseSay = deferred()
		task.say.mockImplementation(async (type) => {
			if (type === "text") {
				sayStarted.resolve()
				await releaseSay.promise
			}
			return undefined
		})

		const presentation = presentAssistantMessage(task as unknown as Task)
		await sayStarted.promise
		task.abort = true
		task.assistantMessageContent.push({ type: "text", content: "after cancellation", partial: false })
		releaseSay.resolve()

		await expect(presentation).rejects.toThrow("aborted")
		expect(textCalls(task)).toEqual([{ text: "before cancellation", partial: true }])
		expect(task.currentStreamingContentIndex).toBe(0)
		expect(task.presentAssistantMessageLocked).toBe(false)
	})

	it("strips thinking tags before rendering text", async () => {
		const task = createTask([{ type: "text", content: "<thinking>internal</thinking> visible", partial: false }])

		await presentAssistantMessage(task as unknown as Task)

		expect(textCalls(task)).toEqual([{ text: "internal visible", partial: false }])
	})

	it("propagates rendering errors without synthetic tool results", async () => {
		const task = createTask([{ type: "text", content: "render me", partial: false }])
		const renderingError = new Error("render failed")
		task.say.mockRejectedValueOnce(renderingError)

		await expect(presentAssistantMessage(task as unknown as Task)).rejects.toThrow("render failed")

		expect(task.pushToolResultToUserContent).not.toHaveBeenCalled()
		expect(task.userMessageContent).toEqual([])
		expect(task.presentAssistantMessageLocked).toBe(false)
	})
})

function createNativeToolBlock(id: string): PreviewBlock {
	return {
		type: "tool_use",
		id,
		name: "read_file",
		params: { path: "README.md" },
		nativeArgs: { path: "README.md" },
		partial: false,
	}
}

function createTask(blocks: PreviewBlock[], didCompleteReadingStream = true): PresentationTask {
	const userMessageContent: unknown[] = []
	const provider = {
		getState: vi.fn().mockResolvedValue({
			mode: "code",
			customModes: [],
			experiments: { customTools: true },
			disabledTools: [],
		}),
		getMcpHub: vi.fn(),
	}
	const task: PresentationTask = {
		taskId: "preview-task",
		instanceId: "preview-instance",
		abort: false,
		presentAssistantMessageLocked: false,
		presentAssistantMessageHasPendingUpdates: false,
		currentStreamingContentIndex: 0,
		assistantMessageContent: blocks,
		userMessageContent,
		userMessageContentReady: false,
		didCompleteReadingStream,
		didRejectTool: false,
		consecutiveMistakeCount: 0,
		api: {
			getModel: vi.fn(() => ({ id: "preview-model", info: {} })),
		},
		providerRef: {
			deref: vi.fn(() => provider),
		},
		getTaskMode: vi.fn().mockResolvedValue("code"),
		getTaskToolDenialReason: vi.fn(),
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		toolRepetitionDetector: {
			check: vi.fn().mockReturnValue({ allowExecution: true }),
		},
		say: vi.fn<SayImplementation>().mockResolvedValue(undefined),
		ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
		pushToolResultToUserContent: vi.fn((result: unknown) => {
			userMessageContent.push(result)
			return true
		}),
		checkpointSave: vi.fn().mockResolvedValue(undefined),
		getTaskCancellationSignal: vi.fn(() => new AbortController().signal),
		isStreamingPreviewEpochCurrent: vi.fn<(epoch: number) => boolean>().mockReturnValue(true),
	}

	return task
}

function textCalls(task: PresentationTask) {
	return task.say.mock.calls.filter(([type]) => type === "text").map(([, text, , partial]) => ({ text, partial }))
}

function deferred() {
	let resolvePromise!: () => void
	const promise = new Promise<void>((resolve) => {
		resolvePromise = resolve
	})
	return { promise, resolve: resolvePromise }
}
