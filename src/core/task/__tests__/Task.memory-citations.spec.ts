import type { Anthropic } from "@anthropic-ai/sdk"
import { DEFAULT_MEMORY_SETTINGS } from "@alpha-code/types"
import { describe, expect, it, vi } from "vitest"
import { createAgentResponse, type AgentResponse } from "../../agent/AgentResponse"
import { TaskMemoryContext } from "../../../services/memory/TaskMemoryContext"
import { Task } from "../Task"

const citation = "<alpha-mem-citation>\n<rollout_ids>\nsource-1\nsource-1\n</rollout_ids>\n</alpha-mem-citation>"
const response = () => createAgentResponse([{ type: "text", text: `An answer.\n${citation}` }])

function fixture(options: { taskKind?: "primary" | "subagent"; diagnosticSession?: boolean; enabled?: boolean } = {}) {
	const recordMemoryUsage = vi.fn(async (_paths: string[], _eventKey?: string) => undefined)
	const provider = { recordMemoryUsage }
	const save = vi.fn(async (_message: Anthropic.MessageParam) => true)
	const retrySave = vi.fn(async () => false)
	const suspend = vi.fn()
	const step = {
		stepId: "turn-1:step-1",
		attemptId: "attempt-1",
		snapshot: { context: { provider: { apiProtocol: "openai" } } },
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "task-1",
		taskKind: options.taskKind ?? "primary",
		diagnosticSession: options.diagnosticSession ?? false,
		taskMemoryContext: new TaskMemoryContext({
			settings: { ...DEFAULT_MEMORY_SETTINGS, enabled: options.enabled ?? true },
			rootPath: "/alpha/memories_v2",
			readSummary: async () => "Learned information",
			...options,
		}),
		providerRef: new WeakRef(provider),
		currentAgentStep: step,
		apiConfiguration: { apiProvider: "openai" },
		addToApiConversationHistory: save,
		retrySaveApiConversationHistory: retrySave,
		suspendAfterCurrentTurn: suspend,
		publishCanonicalLifecycleResponseItems: vi.fn(async () => undefined),
		publishCanonicalLifecyclePendingToolResults: vi.fn(async () => undefined),
	}) as Task
	const persist = Reflect.get(task, "persistAssistantResponseBeforeEffects") as (
		message: Anthropic.MessageParam,
		reasoning: string | undefined,
		response: AgentResponse,
		guard: () => boolean,
	) => Promise<boolean>
	const commit = (output = response(), role: "user" | "assistant" = "assistant", guard = () => true) =>
		persist.call(task, { role, content: output.text }, output.reasoning, output, guard)
	return { task, step, provider, recordMemoryUsage, save, retrySave, suspend, commit }
}

describe("finalized assistant memory citation usage", () => {
	it("records only after durable response persistence and preserves the raw canonical output", async () => {
		const { commit, save, recordMemoryUsage } = fixture()
		let finishSave!: (saved: boolean) => void
		save.mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishSave = resolve)))
		const output = response()
		const committing = commit(output)
		expect(recordMemoryUsage).not.toHaveBeenCalled()
		finishSave(true)
		expect(await committing).toBe(true)
		expect(recordMemoryUsage).toHaveBeenCalledExactlyOnceWith(["source-1"], expect.stringMatching(/^[a-f0-9]{64}$/))
		expect(save.mock.calls[0][0].content).toContain(citation)
		expect(output.text).toContain(citation)
	})

	it("uses stable host-derived receipt keys for replay and distinct keys for later attempts", async () => {
		const { commit, step, recordMemoryUsage } = fixture()
		await commit()
		await commit()
		const first = recordMemoryUsage.mock.calls[0][1]
		expect(recordMemoryUsage.mock.calls[1][1]).toBe(first)
		step.attemptId = "attempt-2"
		await commit()
		expect(recordMemoryUsage.mock.calls[2][1]).not.toBe(first)
	})

	it.each([{ enabled: false }, { taskKind: "subagent" as const }, { diagnosticSession: true }])(
		"does not record citation usage for an excluded task: %j",
		async (options) => {
			const { commit, recordMemoryUsage } = fixture(options)
			expect(await commit()).toBe(true)
			expect(recordMemoryUsage).not.toHaveBeenCalled()
		},
	)

	it("never counts input text, reasoning, tool arguments, or failed responses", async () => {
		const { commit, recordMemoryUsage } = fixture()
		await commit(response(), "user")
		await commit(
			createAgentResponse([
				{ type: "text", text: "An ordinary answer." },
				{ type: "reasoning", text: citation },
				{ type: "tool_call", id: "call-1", name: "read_file", arguments: { text: citation } },
			]),
		)
		for (const status of ["failed", "cancelled", "incomplete"] as const) {
			await commit(createAgentResponse(response().items, { status }))
		}
		expect(recordMemoryUsage).not.toHaveBeenCalled()
	})

	it("does not count a response whose persistence failed or whose step lost ownership", async () => {
		const { commit, save, suspend, recordMemoryUsage } = fixture()
		save.mockResolvedValueOnce(false)
		expect(await commit()).toBe(false)
		expect(suspend).toHaveBeenCalledOnce()
		expect(recordMemoryUsage).not.toHaveBeenCalled()
		let owned = true
		save.mockImplementationOnce(async () => {
			owned = false
			return true
		})
		expect(await commit(response(), "assistant", () => owned)).toBe(false)
		expect(recordMemoryUsage).not.toHaveBeenCalled()
	})

	it("keeps a successful response successful when optional usage storage fails without leaking its error", async () => {
		const { commit, recordMemoryUsage } = fixture()
		recordMemoryUsage.mockRejectedValueOnce(new Error("private memory content and credentials"))
		const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined)
		try {
			expect(await commit()).toBe(true)
			expect(warning).toHaveBeenCalledExactlyOnceWith("[Task#task-1] Alpha memory citation usage is unavailable")
		} finally {
			warning.mockRestore()
		}
	})
})
