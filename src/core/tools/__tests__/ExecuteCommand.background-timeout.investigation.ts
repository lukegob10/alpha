import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"

import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import type { Task } from "../../task/Task"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalCallbacks, AlphaTerminalProcess } from "../../../integrations/terminal/types"
import { executeCommandInTerminal } from "../ExecuteCommandTool"

const directories: string[] = []

afterEach(async () => {
	vi.restoreAllMocks()
	vi.useRealTimers()
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

async function createFixture() {
	const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-background-timeout-probe-")))
	directories.push(cwd)
	await fs.writeFile(path.join(cwd, "fixture.txt"), "unchanged\n")
	const store = new AgentControlStore(new InMemoryAgentControlPersistence())
	await store.initialize()
	await store.ensureRoot({ taskId: "timeout-root", objective: "Run a command", status: "running" })
	const lifetime = new AbortController()
	let launched!: () => void
	const launch = new Promise<void>((resolve) => (launched = resolve))
	let resolveProcess!: () => void
	const processPromise = new Promise<void>((resolve) => (resolveProcess = resolve))
	let callbacks!: AlphaTerminalCallbacks
	const process = Object.assign(new EventEmitter(), {
		isSettled: false,
		then: processPromise.then.bind(processPromise),
		catch: processPromise.catch.bind(processPromise),
		finally: processPromise.finally.bind(processPromise),
		continue: vi.fn(),
		abort: vi.fn(async () => {
			if (process.isSettled) return
			callbacks.onShellExecutionComplete(
				{ exitCode: 130, signalName: "SIGINT" },
				process as unknown as AlphaTerminalProcess,
			)
			await callbacks.onCompleted("stopped", process as unknown as AlphaTerminalProcess)
			process.isSettled = true
			terminal.busy = false
			process.emit("completed", "stopped")
			resolveProcess()
		}),
	})
	const terminal = {
		provider: "execa",
		id: 1,
		taskId: "timeout-root",
		busy: true,
		process,
		getCurrentWorkingDirectory: () => cwd,
		runCommand: (_command: string, handlers: AlphaTerminalCallbacks) => {
			callbacks = handlers
			launched()
			return process
		},
	}
	vi.spyOn(TerminalRegistry, "getOrCreateTerminal").mockResolvedValue(terminal as never)
	vi.spyOn(TerminalRegistry, "getTerminals").mockReturnValue([terminal as never])
	const provider = {
		postMessageToWebview: vi.fn(),
		getState: vi.fn(async () => ({ terminalShellIntegrationDisabled: true })),
		reservePrimaryMutation: vi.fn(async (_task: Task, token: string) => {
			await store.reservePrimaryMutation("timeout-root", "timeout-root", cwd, token)
		}),
		releasePrimaryMutation: vi.fn(async (_task: Task, token: string, incomplete = false) => {
			await store.releasePrimaryMutation("timeout-root", "timeout-root", token, incomplete)
		}),
		recordPrimaryMutation: vi.fn(
			async (_task: Task, files: Record<string, string>, unresolved: boolean, token: string) => {
				return Boolean(
					await store.recordPrimaryMutation({
						rootTaskId: "timeout-root",
						parentTaskId: "timeout-root",
						workspacePath: cwd,
						fileVersions: files,
						scopeUnresolved: unresolved,
						reservationToken: token,
					}),
				)
			},
		),
	}
	const task = {
		cwd,
		taskId: "timeout-root",
		taskKind: "primary",
		abort: false,
		providerRef: { deref: () => provider },
		getTaskLifetimeCancellationSignal: () => lifetime.signal,
		say: vi.fn(async () => undefined),
		admitCommandExecution: vi.fn(async () => undefined),
		completeCommandExecution: vi.fn(),
		markCommandExecutionBackgrounded: vi.fn(),
		failCommandExecution: vi.fn(),
		supersedePendingAsk: vi.fn(),
		suspendAfterCurrentTurn: vi.fn(),
	} as unknown as Task
	return { task, process, store, provider, launch }
}

describe("primary background timeout mutation receipt investigation", () => {
	it("settles the physical reservation when the hard timeout fires after the command yielded", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "background-timeout",
			toolCallId: "background-timeout-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 1_000,
			commandExecutionTimeout: 2_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		expect(fixture.process.abort).not.toHaveBeenCalled()
		expect(fixture.store.getVerificationObligations()[0]?.mutationReservations).toHaveLength(1)
		try {
			await vi.advanceTimersByTimeAsync(1_000)
			expect(fixture.process.abort).toHaveBeenCalledOnce()
			expect(fixture.task.failCommandExecution).toHaveBeenCalledWith(
				"background-timeout-call",
				"timed_out",
				expect.stringMatching(/^background-timeout:/),
			)
			expect(
				fixture.store.getVerificationObligations().flatMap((item) => item.mutationReservations ?? []),
				"The exited background command must publish its final no-op receipt",
			).toEqual([])
		} finally {
			await fixture.process.abort()
		}
	})

	it("settles the same no-op receipt when the hard timeout occurs before foreground return", async () => {
		const fixture = await createFixture()
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] })
		const execution = executeCommandInTerminal(fixture.task, {
			executionId: "foreground-timeout",
			toolCallId: "foreground-timeout-call",
			command: "long-running-command",
			terminalShellIntegrationDisabled: true,
			agentTimeout: 2_000,
			commandExecutionTimeout: 1_000,
		})
		await fixture.launch
		await vi.advanceTimersByTimeAsync(1_100)
		await execution
		expect(fixture.process.abort).toHaveBeenCalledOnce()
		expect(fixture.store.getVerificationObligations().flatMap((item) => item.mutationReservations ?? [])).toEqual(
			[],
		)
		expect(fixture.store.getParentCompletionDecision("timeout-root").allowed).toBe(true)
	})
})
