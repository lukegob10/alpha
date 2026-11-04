import type { AlphaTerminal, AlphaTerminalCallbacks, AlphaTerminalProcess, DirectTerminalCommand } from "../types"
import { MAX_RETAINED_TERMINAL_PROCESSES } from "../types"

const { execaMock } = vi.hoisted(() => ({ execaMock: vi.fn() }))
vi.mock("execa", () => ({ execa: execaMock, ExecaError: class extends Error {} }))
vi.mock("../ripgrepEnvironment", () => ({ getRipgrepPathOverlay: async () => ({}) }))

function deferred() {
	let resolve!: () => void
	const promise = new Promise<void>((done) => (resolve = done))
	return { promise, resolve }
}

const directCommand: DirectTerminalCommand = { executable: "fixture", args: [], env: {} }
const callbacks = (): AlphaTerminalCallbacks => ({
	onLine: () => undefined,
	onCompleted: () => undefined,
	onShellExecutionStarted: () => undefined,
	onShellExecutionComplete: () => undefined,
})

let registry: typeof import("../TerminalRegistry").TerminalRegistry

beforeEach(async () => {
	vi.resetModules()
	registry = (await import("../TerminalRegistry")).TerminalRegistry
	execaMock.mockReset()
	execaMock.mockImplementation(
		() => () =>
			Object.assign(Promise.resolve({ exitCode: 0 }), {
				iterable: () => (async function* () {})(),
			}),
	)
})

afterEach(() => vi.restoreAllMocks())

async function releaseIdleAdapters(count: number, prefix = "idle") {
	for (let index = 0; index < count; index++) {
		const taskId = `${prefix}-${index}`
		const terminal = await registry.getOrCreateTerminal(`/${taskId}`, taskId, "execa")
		registry.releaseTerminalReservation(terminal, taskId)
		registry.releaseTerminalsForTask(taskId)
	}
}

function idleExecaAdapters() {
	return registry.getTerminals(false).filter((terminal) => terminal.provider === "execa")
}

describe("idle Execa adapter retention", () => {
	it("bounds released output-free adapters across distinct directories and keeps VS Code terminals", async () => {
		const vscode = await import("vscode")
		const dispose = vi.fn()
		vi.spyOn(vscode.window, "createTerminal").mockReturnValue({
			exitStatus: undefined,
			dispose,
		} as unknown as import("vscode").Terminal)
		const userTerminal = registry.createTerminal("/vscode-owned", "vscode")
		for (let batch = 0; batch < 8; batch++) {
			await releaseIdleAdapters(MAX_RETAINED_TERMINAL_PROCESSES, `batch-${batch}`)
			expect(idleExecaAdapters()).toHaveLength(MAX_RETAINED_TERMINAL_PROCESSES)
		}
		expect(registry.getTerminals(false)).toContain(userTerminal)
		expect(dispose).not.toHaveBeenCalled()
		expect(registry.getTerminals(true)).toEqual([])
	})

	it.each([false, true])(
		"keeps an empty command's pending finalizer reachable (creation failed=%s)",
		async (fails) => {
			const terminal = await registry.getOrCreateTerminal("/finalizing", "finalizing-task", "execa")
			const entered = deferred()
			const archive = deferred()
			let command: AlphaTerminalProcess | undefined
			let run: Promise<void> | undefined
			const commandCallbacks: AlphaTerminalCallbacks = {
				...callbacks(),
				onProcessCreated: (created) => {
					command = created
					if (fails) throw new Error("Creation hook rejected")
				},
				onOutputClosed: () => {
					entered.resolve()
					return archive.promise
				},
			}
			if (fails) {
				expect(() => terminal.runCommand("fixture", commandCallbacks, directCommand)).toThrow(
					"Creation hook rejected",
				)
			} else {
				run = terminal.runCommand("fixture", commandCallbacks, directCommand)
			}
			try {
				await entered.promise
				expect(terminal.running).toBe(false)
				expect(terminal.process).toBeUndefined()
				expect(terminal.getProcessesWithOutput()).toEqual([])
				expect(command?.isOutputFinalized).toBe(false)
				registry.releaseTerminalsForTask("finalizing-task")
				await releaseIdleAdapters(MAX_RETAINED_TERMINAL_PROCESSES + 1)
				expect(idleExecaAdapters()).toContain(terminal)
				archive.resolve()
				await run
				await command?.waitForOutputFinalization?.()
				await releaseIdleAdapters(MAX_RETAINED_TERMINAL_PROCESSES, "after-finalization")
				expect(idleExecaAdapters()).not.toContain(terminal)
			} finally {
				archive.resolve()
				await run
				await command?.waitForOutputFinalization?.()
			}
		},
	)

	it("preserves unread output and a held receipt until the output is drained", async () => {
		execaMock.mockImplementation(
			() => () =>
				Object.assign(Promise.resolve({ exitCode: 0 }), {
					iterable: () =>
						(async function* () {
							yield "retained output"
						})(),
				}),
		)
		const terminal = await registry.getOrCreateTerminal("/unread-output", "unread-task", "execa")
		const command = terminal.runCommand(
			"fixture",
			{ ...callbacks(), onProcessCreated: (created) => created.continue() },
			directCommand,
		)
		await command
		expect(command.isOutputFinalized).toBe(true)
		const held = command.captureUnretrievedOutput(4)
		try {
			registry.releaseTerminalsForTask("unread-task")
			await releaseIdleAdapters(MAX_RETAINED_TERMINAL_PROCESSES + 1)
			expect(idleExecaAdapters()).toContain(terminal)
			expect(held.output).toBe("reta")
			expect(command.hasActiveOutputReceipt?.()).toBe(true)
			held.release()
			const remaining = command.captureUnretrievedOutput()
			expect(remaining.output).toBe("retained output")
			remaining.commit()
			expect(terminal.getProcessesWithOutput()).toEqual([])
			await releaseIdleAdapters(MAX_RETAINED_TERMINAL_PROCESSES, "after-drain")
			expect(idleExecaAdapters()).not.toContain(terminal)
		} finally {
			held.release()
		}
	})

	it.each(["reserved", "running", "task-owned"] as const)("keeps %s adapters out of idle pruning", async (state) => {
		const terminal = await registry.getOrCreateTerminal("/protected", "protected-task", "execa")
		const exit = deferred()
		const started = deferred()
		let run: Promise<void> | undefined
		if (state === "running") {
			execaMock.mockImplementation(
				() => () =>
					Object.assign(
						exit.promise.then(() => ({ exitCode: 0 })),
						{
							iterable: () =>
								(async function* () {
									await exit.promise
									yield* []
								})(),
						},
					),
			)
			run = terminal.runCommand(
				"fixture",
				{ ...callbacks(), onShellExecutionStarted: () => started.resolve() },
				directCommand,
			)
			await started.promise
		} else if (state === "task-owned") {
			registry.releaseTerminalReservation(terminal, "protected-task")
		}
		try {
			await releaseIdleAdapters(MAX_RETAINED_TERMINAL_PROCESSES + 1)
			const retained: AlphaTerminal[] = [...registry.getTerminals(true), ...registry.getTerminals(false)]
			expect(retained).toContain(terminal)
			expect(terminal.taskId).toBe("protected-task")
		} finally {
			exit.resolve()
			await run
			registry.releaseTerminalsForTask("protected-task")
		}
	})
})
