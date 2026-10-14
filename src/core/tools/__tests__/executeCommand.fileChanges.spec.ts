import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { EventEmitter } from "node:events"
import { afterEach, describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import type { AlphaTerminalCallbacks, AlphaTerminalProcess } from "../../../integrations/terminal/types"
import { executeCommandInTerminal } from "../ExecuteCommandTool"

const directories: string[] = []
afterEach(async () => {
	vi.restoreAllMocks()
	for (const directory of directories.splice(0)) await fs.rm(directory, { recursive: true, force: true })
})

async function startFileChangingCommand(
	exitCode: number,
	cancelBeforeExit = false,
	recordPrimaryMutation: () => Promise<boolean> = async () => true,
) {
	const cwd = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-diff-")))
	directories.push(cwd)
	await fs.writeFile(path.join(cwd, "auth.service.ts"), "user baseline\n")
	const lifetime = new AbortController()
	const say = vi.fn(async (_kind: string, _text?: string) => undefined)
	const provider = {
		getState: vi.fn(async () => ({ terminalShellIntegrationDisabled: true })),
		postMessageToWebview: vi.fn(),
		reservePrimaryMutation: vi.fn(async () => undefined),
		recordPrimaryMutation: vi.fn(recordPrimaryMutation),
		releasePrimaryMutation: vi.fn(async () => undefined),
	}
	const task = {
		cwd,
		taskId: "file-change-task",
		taskKind: "primary",
		abort: false,
		providerRef: { deref: () => provider },
		getTaskLifetimeCancellationSignal: () => lifetime.signal,
		say,
		completeCommandExecution: vi.fn(),
		admitCommandExecution: vi.fn(async () => undefined),
		failCommandExecution: vi.fn(),
		suspendAfterCurrentTurn: vi.fn(),
	} as unknown as Task
	let resolveProcess!: () => void
	const promise = new Promise<void>((resolve) => (resolveProcess = resolve))
	const process = Object.assign(new EventEmitter(), {
		then: promise.then.bind(promise),
		catch: promise.catch.bind(promise),
		finally: promise.finally.bind(promise),
	}) as unknown as AlphaTerminalProcess
	process.continue = vi.fn()
	const terminal = {
		provider: "execa",
		getCurrentWorkingDirectory: () => cwd,
		runCommand: (_command: string, callbacks: AlphaTerminalCallbacks) => {
			void (async () => {
				await fs.writeFile(path.join(cwd, "auth.service.ts"), "agent edit\n")
				if (cancelBeforeExit) lifetime.abort(new Error("cancelled"))
				await callbacks.onCompleted("done", process)
				callbacks.onShellExecutionComplete({ exitCode }, process)
				resolveProcess()
			})()
			return process
		},
	}
	vi.spyOn(TerminalRegistry, "getOrCreateTerminal").mockResolvedValue(terminal as never)
	const execution = executeCommandInTerminal(task, {
		executionId: "auth-write",
		toolCallId: "call-auth-write",
		command: "write auth.service.ts",
		terminalShellIntegrationDisabled: true,
	})
	return { execution, say, provider, task }
}

describe("completed command file changes", () => {
	it("publishes one persisted diff only after the successful mutation receipt", async () => {
		let resolveReceipt!: (value: boolean) => void
		const receipt = new Promise<boolean>((resolve) => (resolveReceipt = resolve))
		const { execution, say, provider } = await startFileChangingCommand(0, false, () => receipt)
		await vi.waitFor(() => expect(provider.recordPrimaryMutation).toHaveBeenCalledOnce())
		expect(say.mock.calls.some(([kind]) => kind === "tool")).toBe(false)
		resolveReceipt(true)
		await execution
		const fileChangeMessages = say.mock.calls
			.filter(([kind]) => kind === "tool")
			.map(([, text]) => JSON.parse(text as string))
		expect(fileChangeMessages).toHaveLength(1)
		expect(fileChangeMessages[0]).toMatchObject({
			tool: "appliedDiff",
			path: "auth.service.ts",
			changeStatus: "applied",
			originalContent: "user baseline\n",
			finalContent: "agent edit\n",
			diffStats: { added: 1, removed: 1 },
		})
		expect(fileChangeMessages[0].commandExecutionId).toMatch(/^auth-write:/)
		expect(provider.recordPrimaryMutation).toHaveBeenCalledOnce()
	})

	it.each([
		[1, false],
		[0, true],
	])("does not present a failed or cancelled command edit (%i, %s)", async (exitCode, cancel) => {
		const { execution, say, provider } = await startFileChangingCommand(exitCode, cancel)
		await execution
		expect(say.mock.calls.some(([kind]) => kind === "tool")).toBe(false)
		expect(provider.recordPrimaryMutation).toHaveBeenCalledOnce()
	})

	it("does not present an edit when the mutation receipt fails", async () => {
		const { execution, say, task } = await startFileChangingCommand(0, false, async () => {
			throw new Error("receipt unavailable")
		})
		await expect(execution).rejects.toThrow("receipt unavailable")
		expect(say.mock.calls.some(([kind]) => kind === "tool")).toBe(false)
		expect(task.suspendAfterCurrentTurn).toHaveBeenCalledOnce()
	})
})
