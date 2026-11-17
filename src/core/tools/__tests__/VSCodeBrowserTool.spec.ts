import { beforeEach, describe, expect, it, vi } from "vitest"

import {
	invokeVSCodeBrowserTool,
	validateVSCodeBrowserToolInvocation,
	VSCodeBrowserToolCancellation,
	VSCodeBrowserToolPreflightError,
} from "../../../services/browser/VSCodeBrowserTools"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerOptions } from "../../agent/ToolScheduler"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import type { Task } from "../../task/Task"
import { createTaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry } from "../ToolRegistry"
import { handleDialogTool, listBrowserPagesTool, openBrowserPageTool, readPageTool } from "../VSCodeBrowserTool"

vi.mock("../../../services/browser/VSCodeBrowserTools", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../services/browser/VSCodeBrowserTools")>()),
	invokeVSCodeBrowserTool: vi.fn(),
	validateVSCodeBrowserToolInvocation: vi.fn(),
}))

function harness(signal?: AbortSignal) {
	const say = vi.fn<Task["say"]>(async () => undefined)
	const task = {
		say,
		canDispatchBrowserTool: vi.fn(() => true),
		beginBrowserToolActivity: vi.fn(async (text: string) => {
			await say("tool", text, undefined, true)
			return (terminalText: string) => say("tool", terminalText, undefined, false)
		}),
		consecutiveMistakeCount: 2,
		recordToolUsage: vi.fn(),
	} as any
	const callbacks = {
		askApproval: vi.fn(async () => true),
		handleError: vi.fn(async () => undefined),
		pushToolResult: vi.fn(),
		setResultMetadata: vi.fn(),
		signal,
	} as any

	return { task, callbacks }
}

function presentations(task: ReturnType<typeof harness>["task"]) {
	return task.say.mock.calls.map((call: unknown[]) => ({
		payload: JSON.parse(call[1] as string),
		partial: call[3],
	}))
}

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settle) => (resolve = settle))
	return { promise, resolve }
}

function scheduledBrowser() {
	const timeline: string[] = []
	const cwd = process.cwd()
	const task = {
		...harness().task,
		taskId: "browser-effect-admission",
		cwd,
		taskKind: "primary",
		consecutiveMistakeCount: 0,
	} as unknown as Task
	const host: ToolExecutionHost = {
		taskId: task.taskId,
		cwd,
		taskFacade: task,
		userMessageContent: [],
		requestToolApproval: vi.fn(async () => {
			timeline.push("approval")
			return { decision: "approve_once" as const }
		}),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	const onEffectStart = vi.fn(async () => {
		timeline.push("effect-start")
	})
	vi.mocked(invokeVSCodeBrowserTool).mockImplementation(async () => {
		timeline.push("host")
		return "Browser action completed"
	})
	const surface = createTaskToolSurface({ registry: new ToolRegistry(), mode: "code", cwd, approvalMode: "ask" })
	const run = (overrides: Partial<ToolSchedulerOptions> = {}) =>
		new ToolScheduler({
			executionHost: host,
			registry: surface.registry,
			policy: surface.policy,
			mode: "code",
			onEffectStart,
			preserveAbortedResults: true,
			...overrides,
		}).run([
			{
				type: "tool_call",
				id: "browser-action-call",
				name: "click_element",
				arguments: { pageId: "page-1", element: "Submit" },
			},
		])
	return { host, onEffectStart, timeline, run }
}

describe("VSCodeBrowserTool", () => {
	beforeEach(() => {
		vi.mocked(invokeVSCodeBrowserTool).mockReset()
		NativeToolCallParser.clearAllStreamingToolCalls()
	})

	it("reaches the VS Code invocation with arguments produced by the native model-call parser", async () => {
		vi.mocked(invokeVSCodeBrowserTool).mockResolvedValue("Opened page page-1")
		const payload = { url: "https://example.com", forceNew: true }
		const block = NativeToolCallParser.parseToolCall({
			id: "model-browser-call",
			name: "open_browser_page",
			arguments: JSON.stringify(payload),
		})
		const { task, callbacks } = harness()

		expect(block?.type).toBe("tool_use")
		if (block?.type !== "tool_use" || !block.nativeArgs) {
			throw new Error("Expected a parsed browser tool call")
		}

		await openBrowserPageTool.execute(block.nativeArgs, task, callbacks)

		expect(invokeVSCodeBrowserTool).toHaveBeenCalledWith("open_browser_page", payload, undefined)
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Opened page page-1")
	})

	it("publishes running and completed status around a successful VS Code invocation", async () => {
		vi.mocked(invokeVSCodeBrowserTool).mockResolvedValue("Page contents")
		const { task, callbacks } = harness()

		await readPageTool.execute({ pageId: "page-1" }, task, callbacks)

		expect(invokeVSCodeBrowserTool).toHaveBeenCalledWith("read_page", { pageId: "page-1" }, undefined)
		expect(presentations(task)).toEqual([
			{
				payload: expect.objectContaining({
					tool: "browserAction",
					action: "read_page",
					status: "running",
					pageId: "page-1",
				}),
				partial: true,
			},
			{
				payload: expect.objectContaining({ action: "read_page", status: "completed" }),
				partial: false,
			},
		])
		expect(task.consecutiveMistakeCount).toBe(0)
		expect(task.recordToolUsage).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "success" })
		expect(callbacks.pushToolResult).toHaveBeenCalledWith("Page contents")
	})

	it("keeps a browser approval separate from running activity", async () => {
		const { task, callbacks } = harness()
		callbacks.askApproval.mockResolvedValue(false)

		await listBrowserPagesTool.execute({}, task, callbacks)

		const approval = JSON.parse(callbacks.askApproval.mock.calls[0][1])
		expect(approval).toEqual({ tool: "browserAction", action: "list_browser_pages" })
		expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
	})

	it("retains the successful host result when browser activity publication rejects", async () => {
		const { task, callbacks } = harness()
		vi.mocked(invokeVSCodeBrowserTool).mockResolvedValue("Pages listed")
		task.say.mockImplementation(async (_type: string, text: string) => {
			if (JSON.parse(text).status === "completed") throw new Error("Webview disconnected")
		})

		await listBrowserPagesTool.execute({}, task, callbacks)

		expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith("Pages listed")
		expect(callbacks.setResultMetadata).toHaveBeenLastCalledWith({ status: "success" })
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it.each([false, true])(
		"does not dispatch after losing Task ownership during activity (rejects=%s)",
		async (rejects) => {
			const cancellation = new AbortController()
			const { task, callbacks } = harness(cancellation.signal)
			const settle = vi.fn(async () => undefined)
			task.beginBrowserToolActivity.mockImplementation(async () => {
				task.canDispatchBrowserTool.mockReturnValue(false)
				if (rejects) throw new Error("Browser activity persistence failed")
				return settle
			})

			await listBrowserPagesTool.execute({}, task, callbacks)

			expect(cancellation.signal.aborted).toBe(false)
			expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
			expect(callbacks.pushToolResult).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("cancelled"))
			expect(callbacks.setResultMetadata).toHaveBeenCalledWith({
				status: "cancelled",
				failure: expect.objectContaining({ reason: "cancelled", effectsStarted: "no", outcome: "known" }),
			})
			if (!rejects) expect(settle).toHaveBeenCalledWith(expect.stringContaining('"status":"cancelled"'))
		},
	)

	it.each([
		{ params: { selectFiles: ["/workspace/test.txt"] }, needsReview: true },
		{ params: { selectFiles: [] }, needsReview: false },
		{ params: { acceptModal: true }, needsReview: false },
	])(
		"requires explicit browser approval only when selecting local files ($params)",
		async ({ params, needsReview }) => {
			const { task, callbacks } = harness()
			callbacks.askApproval.mockResolvedValue(false)

			await handleDialogTool.execute({ pageId: "page-1", ...params }, task, callbacks)

			expect(callbacks.askApproval).toHaveBeenCalledWith(
				"tool",
				expect.stringContaining('"action":"handle_dialog"'),
				undefined,
				undefined,
				needsReview,
			)
			if (needsReview) {
				expect(JSON.parse(callbacks.askApproval.mock.calls[0][1]).selectFiles).toEqual(params.selectFiles)
			}
			expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
		},
	)

	it("replaces the running row with an error and delegates error formatting", async () => {
		vi.mocked(invokeVSCodeBrowserTool).mockRejectedValue(new Error("Browser unavailable"))
		const { task, callbacks } = harness()

		await readPageTool.execute({ pageId: "page-1" }, task, callbacks)

		expect(presentations(task)[1]).toMatchObject({
			payload: { action: "read_page", status: "error" },
			partial: false,
		})
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "error" })
		expect(callbacks.handleError).toHaveBeenCalledWith(
			"using VS Code integrated browser tool read_page",
			expect.objectContaining({ message: "Browser unavailable" }),
		)
	})

	it("returns a cancellation result without reporting a regular tool error", async () => {
		const controller = new AbortController()
		vi.mocked(invokeVSCodeBrowserTool).mockImplementation(async () => {
			controller.abort()
			throw new Error("Cancelled")
		})
		const { task, callbacks } = harness(controller.signal)

		await readPageTool.execute({ pageId: "page-1" }, task, callbacks)

		expect(presentations(task)[1]).toMatchObject({
			payload: { action: "read_page", status: "cancelled" },
			partial: false,
		})
		expect(callbacks.pushToolResult).toHaveBeenCalledWith(expect.stringContaining("cancelled"))
		expect(callbacks.handleError).not.toHaveBeenCalled()
	})

	it("does not publish activity or request approval when already cancelled", async () => {
		const signal = AbortSignal.abort()
		const { task, callbacks } = harness(signal)

		await listBrowserPagesTool.execute({}, task, callbacks)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(task.beginBrowserToolActivity).not.toHaveBeenCalled()
		expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
		expect(callbacks.setResultMetadata).toHaveBeenCalledWith({ status: "cancelled" })
	})
})

describe("VSCodeBrowserTool scheduler admission", () => {
	beforeEach(() => {
		vi.mocked(invokeVSCodeBrowserTool).mockReset()
	})

	it("does not invoke the host after an approval denial", async () => {
		const fixture = scheduledBrowser()
		fixture.host.requestToolApproval = vi.fn(async () => ({ decision: "deny" as const }))

		const outcome = await fixture.run()

		expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
		expect(fixture.onEffectStart).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "denied" }])
		expect(fixture.host.userMessageContent).toHaveLength(1)
	})

	it("honors a permission hook denial before host confirmation", async () => {
		const fixture = scheduledBrowser()
		const permissionRequest = vi.fn(async () => ({ denied: "Browser action requires a different target" }))

		const outcome = await fixture.run({ permissionRequest })

		expect(permissionRequest).toHaveBeenCalledOnce()
		expect(fixture.host.requestToolApproval).not.toHaveBeenCalled()
		expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
		expect(fixture.onEffectStart).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "denied" }])
	})

	it("does not invoke the host when the approval transport rejects", async () => {
		const fixture = scheduledBrowser()
		fixture.host.requestToolApproval = vi.fn(async () => {
			throw new Error("Approval transport unavailable")
		})

		const outcome = await fixture.run()

		expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
		expect(fixture.onEffectStart).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "error" }])
		expect(fixture.host.userMessageContent).toHaveLength(1)
	})

	it("does not invoke the host when durable effect admission rejects", async () => {
		const fixture = scheduledBrowser()
		fixture.onEffectStart.mockRejectedValue(new Error("Effect journal unavailable"))

		const outcome = await fixture.run()

		expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
		expect(outcome).toMatchObject({ status: "failed", failure: { kind: "effect_fence" } })
		expect(outcome.results).toMatchObject([{ status: "error" }])
	})

	it("waits for durable effect admission before invoking the host", async () => {
		const fixture = scheduledBrowser()
		const entered = deferred()
		const saved = deferred()
		fixture.onEffectStart.mockImplementation(async () => {
			entered.resolve()
			await saved.promise
			fixture.timeline.push("effect-start")
		})
		const running = fixture.run()
		try {
			await Promise.race([
				entered.promise,
				running.then(() => {
					throw new Error("Browser action completed without reaching its effect fence")
				}),
			])
			expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
		} finally {
			saved.resolve()
		}
		const outcome = await running

		expect(fixture.timeline).toEqual(["approval", "effect-start", "host"])
		expect(outcome.results).toMatchObject([{ status: "success" }])
	})

	it("retains the browser's original error when publishing the generic error row rejects", async () => {
		const fixture = scheduledBrowser()
		vi.mocked(invokeVSCodeBrowserTool).mockRejectedValue(new Error("Browser host rejected the action"))
		fixture.host.say = vi.fn(async () => {
			throw new Error("Webview disconnected")
		})

		const outcome = await fixture.run()

		expect(outcome.results).toMatchObject([
			{ status: "error", content: expect.stringContaining("Browser host rejected the action") },
		])
		expect(outcome.results[0]?.content).not.toContain("Webview disconnected")
	})

	it.each(["invalid_arguments", "capability_unavailable"] as const)(
		"records %s as a known preflight failure without approval or host effects",
		async (reason) => {
			const fixture = scheduledBrowser()
			vi.mocked(validateVSCodeBrowserToolInvocation).mockImplementationOnce(() => {
				throw new VSCodeBrowserToolPreflightError(reason, "Browser action unavailable")
			})

			const outcome = await fixture.run()

			expect(fixture.host.requestToolApproval).not.toHaveBeenCalled()
			expect(fixture.onEffectStart).not.toHaveBeenCalled()
			expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
			expect(outcome.results).toMatchObject([
				{
					status: "error",
					failure: { reason, effectsStarted: "no", outcome: "known" },
					content: expect.stringContaining("Browser action unavailable"),
				},
			])
		},
	)

	it("records a host confirmation cancellation without an Alpha cancellation signal", async () => {
		const fixture = scheduledBrowser()
		vi.mocked(invokeVSCodeBrowserTool).mockRejectedValue(new VSCodeBrowserToolCancellation())

		const outcome = await fixture.run()

		expect(fixture.onEffectStart).toHaveBeenCalledOnce()
		expect(fixture.host.say).not.toHaveBeenCalledWith("error", expect.anything())
		expect(outcome.results).toMatchObject([
			{
				status: "cancelled",
				content: expect.stringContaining("outcome is unknown"),
				failure: { reason: "outcome_unknown", effectsStarted: "unknown", outcome: "unknown" },
			},
		])
	})

	it("does not invoke the host when Stop wins during effect admission", async () => {
		const fixture = scheduledBrowser()
		const cancellation = new AbortController()
		fixture.onEffectStart.mockImplementation(async () => cancellation.abort())

		const outcome = await fixture.run({ signal: cancellation.signal })

		expect(fixture.onEffectStart).toHaveBeenCalledOnce()
		expect(invokeVSCodeBrowserTool).not.toHaveBeenCalled()
		expect(outcome.results).toMatchObject([{ status: "cancelled" }])
	})

	it("retains uncertainty when Stop arrives after the host action started", async () => {
		const fixture = scheduledBrowser()
		const cancellation = new AbortController()
		vi.mocked(invokeVSCodeBrowserTool).mockImplementation(async () => {
			cancellation.abort()
			return "Browser action completed"
		})

		const outcome = await fixture.run({ signal: cancellation.signal })

		expect(fixture.onEffectStart).toHaveBeenCalledOnce()
		expect(invokeVSCodeBrowserTool).toHaveBeenCalledOnce()
		expect(outcome.results).toMatchObject([
			{ status: "cancelled", content: expect.stringContaining("outcome is unknown") },
		])
	})
})
