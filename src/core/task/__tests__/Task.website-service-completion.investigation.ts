import { Task, type CommandExecutionEvidence } from "../Task"
import type { ParentCompletionDecision } from "../../agent/ParentVerification"

function createFixture(request: string, command: string) {
	const cancellation = new AbortController()
	const evidence: CommandExecutionEvidence = {
		toolCallId: "command-call",
		executionId: "physical-command",
		command,
		status: "running",
		startedAt: Date.now(),
		returnedInBackground: true,
	}
	const provider = {
		getParentCompletionDecision: vi.fn(
			async () =>
				({
					allowed: true,
					blockingObligations: [],
				}) satisfies ParentCompletionDecision,
		),
		recordParentVerificationEvidence: vi.fn(async () => undefined),
		markCompletionWait: vi.fn(),
	}
	const task = Object.assign(Object.create(Task.prototype), {
		taskId: "website-completion-probe",
		taskKind: "primary",
		workspacePath: process.cwd(),
		metadata: { task: request },
		apiConversationHistory: [
			{ role: "user", content: `<user_message>\n${request}\n</user_message>` },
			{
				role: "assistant",
				content: [
					{
						type: "tool_use",
						id: "preview",
						name: "open_browser_page",
						input: { url: "http://localhost:5173" },
					},
				],
			},
			{
				role: "user",
				content: [{ type: "tool_result", tool_use_id: "preview", content: "The website is loaded and ready." }],
			},
		],
		clineMessages: [],
		abort: false,
		taskCancellationController: cancellation,
		commandExecutionEvidence: new Map([[evidence.toolCallId, evidence]]),
		pendingCommandVerification: Promise.resolve(),
		pendingCommandVerificationCount: 0,
		completionRuntimeRevision: 0,
		providerRef: { deref: () => provider },
		hasPendingAgentMessages: () => false,
		getOpenTodoCompletionDecision: () => undefined,
		requireAlphaMessagesSaved: async () => undefined,
		say: vi.fn(async () => undefined),
	}) as Task
	return { task, cancellation, provider }
}

describe("website service completion investigation", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it("reaches a bounded recoverable boundary when a ready preview service intentionally remains alive", async () => {
		const fixture = createFixture(
			"Build a website and launch its development preview.",
			"pnpm dev --host 127.0.0.1",
		)
		let result: Awaited<ReturnType<Task["waitForCompletionGateDecision"]>> | undefined
		const waiting = fixture.task.waitForCompletionGateDecision().then((decision) => {
			result = decision
			return decision
		})
		try {
			// The service has yielded, its browser preview succeeded, and it deliberately has no exit.
			// A bounded pause is sufficient here; this test does not demand unverified completion.
			await vi.advanceTimersByTimeAsync(60_000)
			expect(result, "Ready preview service must not retain the final candidate indefinitely").toBeDefined()
			expect(result?.classification).not.toBe("waiting")
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("does not complete finite verification early while its process remains healthy", async () => {
		const fixture = createFixture("Implement the website and verify it.", "pnpm exec vitest run")
		let settled = false
		const waiting = fixture.task.waitForCompletionGateDecision().then((decision) => {
			settled = true
			return decision
		})
		try {
			await vi.advanceTimersByTimeAsync(60_000)
			expect(settled).toBe(false)
			expect(fixture.provider.getParentCompletionDecision).not.toHaveBeenCalled()
			fixture.task.completeCommandExecution("command-call", { exitCode: 0 }, "physical-command")
			await vi.advanceTimersByTimeAsync(250)
			expect(await waiting).toMatchObject({ allowed: true, classification: "ready" })
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("preserves lookup completion after a background inspection has yielded", async () => {
		const fixture = createFixture("Where is the retry limit defined?", "rg retryLimit src")
		try {
			expect(await fixture.task.waitForCompletionGateDecision()).toMatchObject({
				allowed: true,
				classification: "ready",
			})
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
		}
	})
})
