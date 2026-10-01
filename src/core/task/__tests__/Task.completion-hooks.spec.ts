import { Task } from "../Task"
import { readCompletionHookConfig, runCompletionHooks, type CompletionHookTarget } from "../../agent/CompletionHooks"

vi.mock("../../agent/CompletionHooks", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../agent/CompletionHooks")>()),
	readCompletionHookConfig: vi.fn(),
	runCompletionHooks: vi.fn(),
}))

function fixture(target: CompletionHookTarget = "Stop") {
	const controller = new AbortController()
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "hook-task",
		taskKind: target === "Stop" ? "primary" : "subagent",
		...(target === "SubagentStop" ? { parentTaskId: "parent-task", subagentGroupId: "group" } : {}),
		workspacePath: process.cwd(),
		abort: false,
		didComplete: false,
		completionHookActive: false,
		currentAgentStep: {
			turnId: "same-turn",
			snapshot: { context: { provider: { modelId: "fixture-model" } } },
		},
		completionHookTranscriptPath: vi.fn(async () => null),
		getApprovalModeForAsk: vi.fn(() => "ask"),
		getTaskLifetimeCancellationSignal: () => controller.signal,
		say: vi.fn(async () => undefined),
	}) as Task
	vi.mocked(readCompletionHookConfig).mockReturnValue({
		stop: [{ command: process.execPath }],
		subagentStop: [{ command: process.execPath }],
	})
	return { task, controller }
}

beforeEach(() => vi.resetAllMocks())

describe("configured completion hook continuations", () => {
	it.each(["Stop", "SubagentStop"] as const)(
		"preserves more than three ordered %s blocks until the hook allows completion",
		async (target) => {
			const { task } = fixture(target)
			let invocation = 0
			vi.mocked(runCompletionHooks).mockImplementation(async () => {
				const number = ++invocation
				return number <= 4
					? {
							prompt: `Repair ${number}`,
							fragments: [{ hook_run_id: `hook-${number}`, text: `Repair ${number}` }],
							warnings: [],
						}
					: { warnings: [] }
			})
			const prompts = []
			for (let number = 1; number <= 4; number++) {
				const outcome = await task.evaluateCompletionHooks(`Candidate ${number}`)
				expect(outcome.prompt).toBe(`Repair ${number}`)
				expect(outcome.hookPrompt).toEqual({
					event: target,
					fragments: [{ hook_run_id: `hook-${number}`, text: `Repair ${number}` }],
				})
				prompts.push(outcome.prompt)
				expect(task.isCompleted()).toBe(false)
			}
			expect(await task.evaluateCompletionHooks("Final candidate")).toEqual({})
			expect(prompts).toEqual(["Repair 1", "Repair 2", "Repair 3", "Repair 4"])
			expect(vi.mocked(runCompletionHooks).mock.calls.map(([, request]) => request.stop_hook_active)).toEqual([
				false,
				true,
				true,
				true,
				true,
			])
			expect(vi.mocked(runCompletionHooks).mock.calls.map(([, request]) => request.turn_id)).toEqual(
				Array(5).fill("same-turn"),
			)
			expect(task.say).not.toHaveBeenCalled()
		},
	)

	it("discards a late blocking result when the user cancels its hook window", async () => {
		const { task, controller } = fixture()
		let entered!: () => void
		let finish!: () => void
		const started = new Promise<void>((resolve) => (entered = resolve))
		const barrier = new Promise<void>((resolve) => (finish = resolve))
		vi.mocked(runCompletionHooks).mockImplementation(async (_config, _request, signal) => {
			expect(signal).toBe(controller.signal)
			entered()
			await barrier
			return { prompt: "Late repair", fragments: [{ hook_run_id: "late", text: "Late repair" }], warnings: [] }
		})
		const evaluation = task.evaluateCompletionHooks("Candidate")
		await started
		controller.abort(new Error("user cancelled"))
		finish()
		expect(await evaluation).toEqual({})
		expect(task.isCompleted()).toBe(false)
		expect(task.say).not.toHaveBeenCalled()
	})
})
