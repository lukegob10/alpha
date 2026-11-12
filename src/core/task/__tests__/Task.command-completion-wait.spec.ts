import { EventEmitter } from "node:events"
import { Task, type CommandExecutionEvidence } from "../Task"
import type { ParentCompletionDecision } from "../../agent/ParentVerification"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { AlphaProvider } from "../../webview/AlphaProvider"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminal, AlphaTerminalProcessEvents } from "../../../integrations/terminal/types"

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((settled) => (resolve = settled))
	return { promise, resolve }
}

function trackLiveBackgroundProcess(task: Task) {
	const evidence = task.getCommandExecutionEvidence()[0]!
	const process = Object.assign(new EventEmitter<AlphaTerminalProcessEvents>(), {
		executionId: evidence.executionId,
		isSettled: false,
	})
	const terminal = { taskId: task.taskId, process, running: true }
	const getTerminals = vi
		.spyOn(TerminalRegistry, "getTerminals")
		.mockReturnValue([terminal as unknown as AlphaTerminal])
	return { process, terminal, getTerminals }
}

function createFixture(request: string, command: string, overrides: Partial<CommandExecutionEvidence> = {}) {
	const cancellation = new AbortController()
	const evidence: CommandExecutionEvidence = {
		toolCallId: "command-call",
		executionId: "physical-command",
		command,
		status: "running",
		startedAt: Date.now(),
		returnedInBackground: true,
		...overrides,
	}
	const provider = {
		getParentCompletionDecision: vi.fn(
			async () =>
				({
					allowed: true,
					blockingObligations: [],
				}) satisfies ParentCompletionDecision,
		),
		recordParentVerificationEvidence: vi.fn(async (): Promise<void> => undefined),
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
		alphaMessages: [],
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

async function attachMutationLedger(task: Task) {
	const persistence = new InMemoryAgentControlPersistence()
	const store = new AgentControlStore(persistence)
	await store.initialize()
	await store.ensureRoot({ taskId: task.taskId, objective: "Launch an application", status: "running" })
	const provider = Object.assign(Object.create(AlphaProvider.prototype), {
		agentControlStore: store,
		agentControlStoreReady: Promise.resolve(),
		recordParentVerificationEvidence: async () => undefined,
		ensureAgentControlRoot: async () => ({ rootTaskId: task.taskId }),
		reconcileWaitAgentClaims: async () => undefined,
	}) as AlphaProvider
	Object.assign(task, { providerRef: { deref: () => provider } })
	const executionId = task.getCommandExecutionEvidence()[0]!.executionId
	await store.reservePrimaryMutation(task.taskId, task.taskId, task.cwd, executionId)
	return { store, persistence, executionId }
}

describe("completion command observation", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.useRealTimers()
	})

	it.each([
		["Launch the application.", "node application.cjs"],
		["Build the application and start its preview.", "pnpm dev"],
	])("allows %s to finish while its owned background process stays alive", async (request, command) => {
		const fixture = createFixture(request, command)
		const { process } = trackLiveBackgroundProcess(fixture.task)
		expect(await fixture.task.waitForCompletionGateDecision()).toMatchObject({
			allowed: true,
			classification: "ready",
		})
		expect(process.isSettled).toBe(false)
		expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: "running" })
		expect(fixture.task.getCommandExecutionEvidence()[0]).not.toHaveProperty("exitCode")
	})

	it("keeps an explicitly associated verification process blocking after it yields", async () => {
		const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
			verificationChangeSetIds: ["changed-files"],
		})
		trackLiveBackgroundProcess(fixture.task)
		expect(await fixture.task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "waiting",
			reasonCode: "command_running",
		})
	})

	it("keeps a declared acceptance check blocking after its process yields", async () => {
		const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
			acceptanceChecks: [
				{
					checkId: "check",
					definitionDigest: "definition",
					executionId: "physical-command",
					status: "running",
					observedAt: Date.now(),
				},
			],
		})
		trackLiveBackgroundProcess(fixture.task)
		expect(await fixture.task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			reasonCode: "command_running",
		})
	})

	it.each(["other-task", "reused-terminal", "settled", "stopped", "foreground", "subagent"])(
		"requires live primary process ownership: %s",
		async (condition) => {
			const fixture = createFixture("Launch the application.", "node application.cjs")
			const { process, terminal } = trackLiveBackgroundProcess(fixture.task)
			if (condition === "other-task") terminal.taskId = "other-task"
			if (condition === "reused-terminal") process.executionId = "another-execution"
			if (condition === "settled") process.isSettled = true
			if (condition === "stopped") terminal.running = false
			if (condition === "foreground")
				Object.assign(fixture.task, {
					commandExecutionEvidence: new Map([
						[
							"command-call",
							{ ...fixture.task.getCommandExecutionEvidence()[0], returnedInBackground: false },
						],
					]),
				})
			if (condition === "subagent") Object.assign(fixture.task, { taskKind: "subagent" })
			expect(await fixture.task.getCompletionGateDecision()).toMatchObject({
				allowed: false,
				reasonCode: "command_running",
			})
		},
	)

	it("rejects a stale completion snapshot when background process ownership changes during its read", async () => {
		const fixture = createFixture("Launch the application.", "node application.cjs")
		const { process } = trackLiveBackgroundProcess(fixture.task)
		fixture.provider.getParentCompletionDecision.mockImplementationOnce(async () => {
			process.executionId = "another-execution"
			return { allowed: true, blockingObligations: [] }
		})
		expect(await fixture.task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			reasonCode: "command_running",
		})
	})

	it("records the yield transition once and only for the matching physical execution", () => {
		const fixture = createFixture("Launch the application.", "node application.cjs", {
			returnedInBackground: false,
		})
		fixture.task.markCommandExecutionBackgrounded("command-call", "wrong-execution")
		fixture.task.markCommandExecutionBackgrounded("command-call", "physical-command")
		fixture.task.markCommandExecutionBackgrounded("command-call", "physical-command")
		expect(fixture.task).toHaveProperty("completionRuntimeRevision", 1)
	})

	it("keeps a live launch reservation durable without reporting it as an orphaned receipt", async () => {
		const fixture = createFixture("Launch the application.", "node application.cjs")
		trackLiveBackgroundProcess(fixture.task)
		const { store, persistence, executionId } = await attachMutationLedger(fixture.task)
		expect(await fixture.task.getCompletionGateDecision()).toMatchObject({ allowed: true, classification: "ready" })
		expect(store.getVerificationObligations()[0]?.mutationReservations).toEqual([executionId])
		// Durable history alone cannot claim that a process survived a reload.
		const restored = new AgentControlStore(persistence)
		await restored.initialize()
		expect(restored.getParentCompletionDecision(fixture.task.taskId).allowed).toBe(false)
		await store.recordPrimaryMutation({
			rootTaskId: fixture.task.taskId,
			parentTaskId: fixture.task.taskId,
			workspacePath: fixture.task.cwd,
			fileVersions: { "runtime.log": "changed" },
			reservationToken: executionId,
		})
		expect(store.getVerificationObligations()[0]?.mutationReservations).toEqual([])
	})

	it("does not apply the orphan-receipt deadline to an owned background process in a lookup turn", async () => {
		const fixture = createFixture("Where is the live application preview?", "node application.cjs")
		trackLiveBackgroundProcess(fixture.task)
		const { store, executionId } = await attachMutationLedger(fixture.task)
		let decision: Awaited<ReturnType<Task["waitForCompletionGateDecision"]>> | undefined
		const waiting = fixture.task.waitForCompletionGateDecision().then((value) => {
			decision = value
			return value
		})
		try {
			await vi.advanceTimersByTimeAsync(60_000)
			expect(decision).toMatchObject({ allowed: true, classification: "ready" })
			expect(store.getVerificationObligations()[0]?.mutationReservations).toEqual([executionId])
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("does not exempt another missing receipt just because an application is running", async () => {
		const fixture = createFixture("Launch the application.", "node application.cjs")
		trackLiveBackgroundProcess(fixture.task)
		const { store } = await attachMutationLedger(fixture.task)
		await store.reservePrimaryMutation(fixture.task.taskId, fixture.task.taskId, fixture.task.cwd, "another-write")
		expect(await fixture.task.getCompletionGateDecision()).toMatchObject({
			allowed: false,
			classification: "waiting",
			reasonCode: "receipt_pending",
		})
	})

	it("bounds command observation when a preview has no live process owner", async () => {
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
			// A successful browser preview alone cannot establish ownership of a live process.
			await vi.advanceTimersByTimeAsync(60_000)
			expect(result).toMatchObject({
				allowed: false,
				classification: "blocked",
				reasonCode: "runtime_timeout",
			})
			expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: "running" })
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("does not poll finite verification and wakes only after output and evidence settle", async () => {
		const fixture = createFixture("Implement the website and verify it.", "pnpm exec vitest run", {
			verificationChangeSetIds: ["changed-files"],
		})
		const { process, terminal } = trackLiveBackgroundProcess(fixture.task)
		const persistence = deferred()
		fixture.provider.recordParentVerificationEvidence.mockReturnValueOnce(persistence.promise)
		const checkCompletion = vi.spyOn(fixture.task, "getCompletionGateDecision")
		let settled = false
		const waiting = fixture.task.waitForCompletionGateDecision().then((decision) => {
			settled = true
			return decision
		})
		try {
			await vi.advanceTimersByTimeAsync(60_000)
			expect(settled).toBe(false)
			expect(checkCompletion).toHaveBeenCalledTimes(1)
			expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: "running" })
			expect(fixture.provider.getParentCompletionDecision).not.toHaveBeenCalled()
			fixture.task.markCommandExecutionExitObserved("command-call", "retired-execution")
			await vi.advanceTimersByTimeAsync(0)
			expect(checkCompletion).toHaveBeenCalledTimes(1)
			terminal.running = false
			fixture.task.markCommandExecutionExitObserved("command-call", "physical-command")
			process.emit("shell_execution_complete", { exitCode: 0 })
			await vi.advanceTimersByTimeAsync(10_000)
			expect(checkCompletion).toHaveBeenCalledTimes(2)
			expect(settled).toBe(false)
			expect(fixture.provider.getParentCompletionDecision).not.toHaveBeenCalled()
			expect(process.eventNames()).toEqual([])
			process.isSettled = true
			process.emit("completed", "verification output")
			fixture.task.completeCommandExecution("command-call", { exitCode: 0 }, "physical-command")
			await vi.advanceTimersByTimeAsync(0)
			expect(fixture.provider.recordParentVerificationEvidence).toHaveBeenCalledOnce()
			expect(fixture.provider.getParentCompletionDecision).not.toHaveBeenCalled()
			expect(settled).toBe(false)
			persistence.resolve()
			await vi.advanceTimersByTimeAsync(0)
			expect(settled).toBe(true)
			expect(await waiting).toMatchObject({
				allowed: true,
				classification: "ready",
			})
			expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: "succeeded", exitCode: 0 })
			expect(fixture.provider.getParentCompletionDecision).toHaveBeenCalledOnce()
		} finally {
			persistence.resolve()
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("retains the unowned-command deadline while a different command's evidence publishes", async () => {
		const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
			verificationChangeSetIds: ["changed-files"],
		})
		const publication = deferred()
		fixture.provider.recordParentVerificationEvidence.mockReturnValueOnce(publication.promise)
		fixture.task.beginCommandExecution("another-call", "another-execution", "node --version")
		fixture.task.completeCommandExecution("another-call", { exitCode: 0 }, "another-execution")
		let result: Awaited<ReturnType<Task["waitForCompletionGateDecision"]>> | undefined
		const waiting = fixture.task.waitForCompletionGateDecision().then((decision) => {
			result = decision
		})
		try {
			await vi.advanceTimersByTimeAsync(29_000)
			expect(result).toBeUndefined()
			publication.resolve()
			await vi.advanceTimersByTimeAsync(2_000)
			expect(result).toMatchObject({ classification: "blocked", reasonCode: "runtime_timeout" })
		} finally {
			publication.resolve()
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("handles a command finishing while the first wait status is being published", async () => {
		const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
			verificationChangeSetIds: ["changed-files"],
		})
		const { process, terminal } = trackLiveBackgroundProcess(fixture.task)
		const publishing = deferred()
		vi.mocked(fixture.task.say).mockImplementationOnce(async () => {
			await publishing.promise
			return undefined
		})
		const waiting = fixture.task.waitForCompletionGateDecision()
		try {
			await vi.advanceTimersByTimeAsync(0)
			expect(fixture.provider.markCompletionWait).toHaveBeenCalledWith(fixture.task.taskId, "command_running")
			expect(process.eventNames()).toEqual([])
			terminal.running = false
			process.isSettled = true
			fixture.task.markCommandExecutionExitObserved("command-call", "physical-command")
			fixture.task.completeCommandExecution("command-call", { exitCode: 0 }, "physical-command")
			await vi.advanceTimersByTimeAsync(0)
			publishing.resolve()
			await expect(waiting).resolves.toMatchObject({ allowed: true, classification: "ready" })
			expect(fixture.provider.getParentCompletionDecision).toHaveBeenCalledOnce()
		} finally {
			publishing.resolve()
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("bounds stalled post-exit settlement without polling or changing the command outcome", async () => {
		const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
			verificationChangeSetIds: ["changed-files"],
		})
		const { process, terminal } = trackLiveBackgroundProcess(fixture.task)
		const checkCompletion = vi.spyOn(fixture.task, "getCompletionGateDecision")
		const waiting = fixture.task.waitForCompletionGateDecision()
		try {
			await vi.advanceTimersByTimeAsync(0)
			terminal.running = false
			fixture.task.markCommandExecutionExitObserved("command-call", "physical-command")
			process.emit("shell_execution_complete", { exitCode: 0 })
			await vi.advanceTimersByTimeAsync(30_000)
			await expect(waiting).resolves.toMatchObject({ classification: "blocked", reasonCode: "runtime_timeout" })
			expect(checkCompletion).toHaveBeenCalledTimes(2)
			expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: "running" })
			expect(process.eventNames()).toEqual([])
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("fails closed if command evidence cannot be saved after an owned command ends", async () => {
		const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
			verificationChangeSetIds: ["changed-files"],
		})
		const { process, terminal } = trackLiveBackgroundProcess(fixture.task)
		vi.spyOn(console, "error").mockImplementation(() => undefined)
		fixture.provider.recordParentVerificationEvidence.mockRejectedValueOnce(
			new Error("Verification store unavailable"),
		)
		const waiting = fixture.task.waitForCompletionGateDecision()
		try {
			await vi.advanceTimersByTimeAsync(0)
			terminal.running = false
			fixture.task.markCommandExecutionExitObserved("command-call", "physical-command")
			fixture.task.completeCommandExecution("command-call", { exitCode: 0 }, "physical-command")
			await expect(waiting).resolves.toMatchObject({
				classification: "blocked",
				reasonCode: "persistence_unavailable",
			})
			expect(fixture.provider.getParentCompletionDecision).not.toHaveBeenCalled()
			expect(process.eventNames()).toEqual([])
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it.each(["missing", "settled", "foreign-task", "reused-execution", "stopped"])(
		"starts bounded observation only after a healthy process loses ownership: %s",
		async (loss) => {
			const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
				verificationChangeSetIds: ["changed-files"],
			})
			const { process, terminal, getTerminals } = trackLiveBackgroundProcess(fixture.task)
			// A process can settle asynchronously while its terminal has returned to the idle set.
			getTerminals.mockImplementation((busy) => (busy ? [] : [terminal as unknown as AlphaTerminal]))
			let result: Awaited<ReturnType<Task["waitForCompletionGateDecision"]>> | undefined
			const waiting = fixture.task.waitForCompletionGateDecision().then((decision) => {
				result = decision
				return decision
			})
			try {
				await vi.advanceTimersByTimeAsync(60_000)
				expect(result).toBeUndefined()
				if (loss === "missing") getTerminals.mockReturnValue([])
				else if (loss === "settled") process.isSettled = true
				else if (loss === "foreign-task") terminal.taskId = "another-task"
				else if (loss === "reused-execution") process.executionId = "another-execution"
				else terminal.running = false
				// The terminal emits an outcome when its ownership of a live execution ends.
				process.emit(loss === "settled" ? "completed" : "terminal_closed")

				await vi.advanceTimersByTimeAsync(29_000)
				expect(result).toBeUndefined()
				await vi.advanceTimersByTimeAsync(2_000)
				expect(result).toMatchObject({
					allowed: false,
					classification: "blocked",
					reasonCode: "runtime_timeout",
				})
				expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({
					executionId: "physical-command",
					status: "running",
				})
				expect(fixture.provider.getParentCompletionDecision).not.toHaveBeenCalled()
			} finally {
				fixture.cancellation.abort(new Error("Probe cleanup"))
				await waiting
			}
		},
	)

	it("interrupts a healthy command wait after the observation window without changing its execution evidence", async () => {
		const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
			verificationChangeSetIds: ["changed-files"],
		})
		const { process } = trackLiveBackgroundProcess(fixture.task)
		let settled = false
		const waiting = fixture.task.waitForCompletionGateDecision().then((decision) => {
			settled = true
			return decision
		})
		try {
			await vi.advanceTimersByTimeAsync(60_000)
			expect(settled).toBe(false)
			fixture.cancellation.abort(new Error("User interrupted command observation"))
			expect(await waiting).toMatchObject({
				allowed: false,
				classification: "blocked",
				reasonCode: "interrupted",
			})
			expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({ status: "running" })
			expect(process.eventNames()).toEqual([])
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("ignores lookup-exempt background evidence while waiting for a healthy scoped command", async () => {
		const fixture = createFixture("Where is the retry limit defined?", "node checks.cjs", {
			verificationChangeSetIds: ["changed-files"],
		})
		const orphan: CommandExecutionEvidence = {
			toolCallId: "orphan-call",
			executionId: "orphan-execution",
			command: "node preview.cjs",
			status: "running",
			startedAt: Date.now(),
			returnedInBackground: true,
		}
		Object.assign(fixture.task, {
			commandExecutionEvidence: new Map([
				["command-call", fixture.task.getCommandExecutionEvidence()[0]!],
				[orphan.toolCallId, orphan],
			]),
		})
		trackLiveBackgroundProcess(fixture.task)
		let result: Awaited<ReturnType<Task["waitForCompletionGateDecision"]>> | undefined
		const waiting = fixture.task.waitForCompletionGateDecision().then((decision) => {
			result = decision
			return decision
		})
		try {
			await vi.advanceTimersByTimeAsync(60_000)
			expect(result).toBeUndefined()
			fixture.task.completeCommandExecution("command-call", { exitCode: 0 }, "physical-command")
			await vi.advanceTimersByTimeAsync(250)
			expect(await waiting).toMatchObject({ allowed: true, classification: "ready" })
			expect(orphan).toMatchObject({ status: "running", executionId: "orphan-execution" })
		} finally {
			fixture.cancellation.abort(new Error("Probe cleanup"))
			await waiting
		}
	})

	it("ends observation on a command timeout receipt while preserving its failed status", async () => {
		const fixture = createFixture("Implement and verify the application.", "node checks.cjs", {
			verificationChangeSetIds: ["changed-files"],
		})
		trackLiveBackgroundProcess(fixture.task)
		let settled = false
		const waiting = fixture.task.waitForCompletionGateDecision().then((decision) => {
			settled = true
			return decision
		})
		try {
			await vi.advanceTimersByTimeAsync(60_000)
			expect(settled).toBe(false)
			fixture.task.completeCommandExecution("command-call", { signalName: "SIGTERM" }, "physical-command")
			await vi.advanceTimersByTimeAsync(250)
			expect(await waiting).toMatchObject({ allowed: true, classification: "ready" })
			expect(fixture.task.getCommandExecutionEvidence()[0]).toMatchObject({
				status: "failed",
				signalName: "SIGTERM",
			})
			expect(fixture.task.getCommandExecutionEvidence()[0]?.exitCode).toBeUndefined()
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
