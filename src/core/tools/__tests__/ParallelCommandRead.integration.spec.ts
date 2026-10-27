import fs from "fs/promises"
import os from "os"
import path from "path"
import { execa } from "execa"
import type { AlphaAsk, AlphaMessage, CommandExecutionStatus } from "@alpha-code/types"

import { Task, type CommandExecutionEvidence } from "../../task/Task"
import { ToolRegistry } from "../ToolRegistry"
import { ToolScheduler, type ToolExecutionHost } from "../../agent/ToolScheduler"
import { AgentControlStore, InMemoryAgentControlPersistence } from "../../agent/AgentControlStore"
import { createTaskToolSurface } from "../TaskToolSurface"
import { getNativeTools } from "../../prompts/tools/native-tools"
import { NativeToolCallParser } from "../../assistant-message/NativeToolCallParser"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"
import { commandSessionRegistry } from "../CommandSessionRegistry"
import { getTaskDirectoryPath } from "../../../utils/storage"
import { AlphaIgnoreController } from "../../ignore/AlphaIgnoreController"
import { AlphaProtectedController } from "../../protect/AlphaProtectedController"

vi.mock("vscode", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscode")>()),
	RelativePattern: class {
		constructor(
			readonly base: string,
			readonly pattern: string,
		) {}
	},
}))

vi.mock("node:worker_threads", async (importOriginal) => {
	const original = await importOriginal<typeof import("node:worker_threads")>()
	const { readFileSync } = await import("node:fs")
	const { transformSync } = await import("esbuild")
	const nodePath = await import("node:path")
	const source = transformSync(
		readFileSync(nodePath.resolve(process.cwd(), "workers/searchCommandOutput.ts"), "utf8"),
		{
			loader: "ts",
			format: "cjs",
		},
	).code
	class SearchTestWorker extends original.Worker {
		constructor(filename: string | URL, options?: import("node:worker_threads").WorkerOptions) {
			// Focused source tests must not depend on a previously bundled worker.
			const isSearchWorker =
				typeof filename === "string" && nodePath.basename(filename) === "searchCommandOutput.js"
			super(isSearchWorker ? source : filename, isSearchWorker ? { ...options, eval: true } : options)
		}
	}
	return { ...original, Worker: SearchTestWorker }
})

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

async function commandFixture(
	root: string,
	taskId: string,
	storage?: string,
	getMode: () => "code" | "architect" = () => "code",
	publishApprovalRows = true,
) {
	const state = {
		disabledTools: [] as string[],
		allowedCommands: [],
		deniedCommands: [],
		terminalShellIntegrationDisabled: true,
		terminalOutputPreviewSize: "small" as const,
	}
	const store = new AgentControlStore(new InMemoryAgentControlPersistence())
	await store.initialize()
	await store.ensureRoot({ taskId, objective: "Inspect real command output", status: "running" })
	const lifetime = new AbortController()
	const ignoreController = new AlphaIgnoreController(root)
	await ignoreController.initialize()
	const commandOutputOwners: string[] = []
	const provider = {
		getValue: (key: keyof typeof state) => state[key],
		getValues: () => state,
		getState: async () => state,
		context: storage ? { globalStorageUri: { fsPath: storage } } : {},
		postMessageToWebview: vi.fn(),
		runWorkspaceMutation: async <T>(_task: Task, _label: string, run: () => Promise<T>) => run(),
		reservePrimaryMutation: vi.fn(async (_task: Task, token: string) => {
			await store.reservePrimaryMutation(taskId, taskId, root, token)
		}),
		releasePrimaryMutation: vi.fn(async (_task: Task, token: string, incomplete = false) => {
			await store.releasePrimaryMutation(taskId, taskId, token, incomplete)
		}),
		recordPrimaryMutation: vi.fn(
			async (_task: Task, files: Record<string, string>, unresolved: boolean, token: string) =>
				Boolean(
					await store.recordPrimaryMutation({
						rootTaskId: taskId,
						parentTaskId: taskId,
						workspacePath: root,
						fileVersions: files,
						scopeUnresolved: unresolved,
						reservationToken: token,
					}),
				),
		),
	}
	const task = {
		taskId,
		taskKind: "primary",
		cwd: root,
		taskMode: getMode(),
		abort: false,
		alphaIgnoreController: ignoreController,
		alphaProtectedController: new AlphaProtectedController(root),
		getTaskMode: async () => getMode(),
		getTaskLifetimeCancellationSignal: () => lifetime.signal,
		providerRef: { deref: () => provider },
		lastMessageTs: 1_000,
		alphaMessages: [],
		consecutiveMistakeCount: 0,
		commandExecutionEvidence: new Map<string, CommandExecutionEvidence>(),
		pendingCommandVerification: Promise.resolve(),
		completionRuntimeRevision: 0,
		beginCommandExecution: Task.prototype.beginCommandExecution,
		admitCommandExecution: vi.fn(Task.prototype.admitCommandExecution),
		completeCommandExecution: vi.fn(Task.prototype.completeCommandExecution),
		failCommandExecution: Task.prototype.failCommandExecution,
		getCommandExecutionEvidence: Task.prototype.getCommandExecutionEvidence,
		markCommandExecutionBackgrounded: Task.prototype.markCommandExecutionBackgrounded,
		presentApprovedCommand: Task.prototype.presentApprovedCommand,
		reserveUiMessageTimestamp: Task.prototype["reserveUiMessageTimestamp"],
		observeUiMessageTimestamps: Task.prototype["observeUiMessageTimestamps"],
		addToAlphaMessages: async (message: AlphaMessage) => {
			task["observeUiMessageTimestamps"]([message])
			task.alphaMessages.push(message)
		},
		prepareCommandEvidenceSlot: Task.prototype["prepareCommandEvidenceSlot"],
		enqueueCommandEvidence: Task.prototype["enqueueCommandEvidence"],
		publishParentVerificationEvidence: vi.fn(),
		suspendAfterCurrentTurn: vi.fn(),
		recordToolError: vi.fn(),
		ask: vi.fn(async () => ({ response: "yesButtonClicked" as const })),
		say: vi.fn<Task["say"]>(async (type, _text, _images, _partial, _progress, _protected, options) => {
			if (type === "command_output") {
				const approval = task.alphaMessages.find(
					(message) =>
						message.type === "ask" &&
						message.ask === "command" &&
						message.ts.toString() === options?.commandExecutionId,
				)
				expect(approval).toBeDefined()
				const owners = task
					.getCommandExecutionEvidence()
					.filter(
						({ executionId, command }) =>
							executionId?.startsWith(`${options?.commandExecutionId}:`) && command === approval?.text,
					)
				expect(owners).toHaveLength(1)
				expect(owners[0].status).toBe("running")
				commandOutputOwners.push(owners[0].toolCallId)
			}
			return undefined
		}),
	} as unknown as Task
	const host: ToolExecutionHost = {
		taskId,
		cwd: root,
		taskFacade: task,
		userMessageContent: [],
		say: async () => {},
		recordToolUsage: vi.fn(),
		askApproval: vi.fn(async (type: AlphaAsk, command?: string) => {
			expect(type).toBe("command")
			if (!publishApprovalRows) return { response: "yesButtonClicked" as const }
			task.lastMessageTs = (task.lastMessageTs ?? 0) + 1
			task.alphaMessages.push({ ts: task.lastMessageTs, type: "ask", ask: "command", text: command })
			return { response: "yesButtonClicked" as const, commandExecutionId: task.lastMessageTs.toString() }
		}),
		pushToolResultToUserContent(result) {
			host.userMessageContent.push(result)
			return true
		},
	}
	return {
		task,
		host,
		provider,
		state,
		commandOutputOwners,
		async dispose() {
			try {
				for (const terminal of [
					...TerminalRegistry.getTerminals(true, taskId),
					...TerminalRegistry.getTerminals(false, taskId),
				]) {
					if (terminal.running) await terminal.process?.abort()
					await terminal.process?.finalizeOutput?.()
				}
			} finally {
				ignoreController.dispose()
				commandSessionRegistry.releaseForTask(task)
				TerminalRegistry.releaseTerminalsForTask(taskId)
			}
		},
	}
}

describe("command reads through the built-in registry and real subprocesses", () => {
	it.each(["explore", "review", "worker"] as const)(
		"keeps a captured execute=false %s child on the trusted rg reader",
		async (role) => {
			const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), `alpha-readonly-${role}-`)))
			let fixture: Awaited<ReturnType<typeof commandFixture>> | undefined
			try {
				await fs.mkdir(path.join(root, "src"))
				await fs.writeFile(path.join(root, "src", "sample.txt"), "needle owned read\n")
				fixture = await commandFixture(root, `readonly-reader-${role}`)
				const { task, host, provider } = fixture
				Object.assign(task, {
					taskKind: "subagent",
					subagentRole: role,
					subagentContextManifest: {
						skills: [],
						runtimePolicy: { role, read: true, execute: false, allowedTools: ["exec_command"] },
					},
					getTaskAllowedToolNames: Task.prototype.getTaskAllowedToolNames,
					getTaskToolDenialReason: Task.prototype.getTaskToolDenialReason,
					getTaskCommandDenialReason: Task.prototype.getTaskCommandDenialReason,
					isWorkerEditTool: Task.prototype["isWorkerEditTool"],
				})
				host.taskKind = "subagent"
				const surface = createTaskToolSurface({
					registry: new ToolRegistry(),
					mode: "code",
					cwd: root,
					taskKind: "subagent",
					allowedToolNames: ["exec_command"],
				})
				const effects = vi.fn()
				const outcome = await new ToolScheduler({
					executionHost: host,
					registry: surface.registry,
					policy: surface.policy,
					mode: "code",
					executionMode: "selective-parallel",
					onEffectStart: effects,
				}).run([
					{
						type: "tool_call",
						id: "audited-read",
						name: "exec_command",
						arguments: { cmd: "rg -n needle src/sample.txt", yield_time_ms: 10_000 },
					},
					{
						type: "tool_call",
						id: "ordinary-shell",
						name: "exec_command",
						arguments: { cmd: "echo should-not-launch" },
					},
				])

				expect(outcome.results.map(({ callId, status }) => [callId, status])).toEqual([
					["audited-read", "success"],
					["ordinary-shell", "denied"],
				])
				expect(outcome.results[0].content).toContain("needle owned read")
				expect(outcome.results[0].exitCode).toBe(0)
				expect(host.askApproval).toHaveBeenCalledOnce()
				expect(effects).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "audited-read" }))
				expect(host.userMessageContent).toEqual([
					expect.objectContaining({ tool_use_id: "audited-read", is_error: false }),
					expect.objectContaining({ tool_use_id: "ordinary-shell", is_error: true }),
				])
				expect(provider.reservePrimaryMutation).not.toHaveBeenCalled()
				expect(await fs.readFile(path.join(root, "src", "sample.txt"), "utf8")).toBe("needle owned read\n")
			} finally {
				await fixture?.dispose()
				await fs.rm(root, { recursive: true, force: true })
			}
		},
	)

	it("archives 400 real rg lines before assistant durability and commits their shared collector once afterward", async () => {
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-prepared-held-tail-")))
		const root = path.join(directory, "workspace")
		const storage = path.join(directory, "storage")
		const durable = deferred<void>()
		let fixture: Awaited<ReturnType<typeof commandFixture>> | undefined
		let scheduler: ToolScheduler | undefined
		let commit: Promise<void> | undefined
		try {
			await fs.mkdir(path.join(root, "src"), { recursive: true })
			await fs.writeFile(path.join(root, ".alphaignore"), "src/hidden.txt\n")
			await fs.writeFile(path.join(root, "src", "hidden.txt"), "HELD_PROOF_ignored must remain private\n")
			const lines = Array.from({ length: 400 }, (_, index) => `HELD_PROOF_${index} ${"x".repeat(256)}`)
			await fs.writeFile(path.join(root, "src", "held-proof.txt"), lines.join("\n") + "\n")
			fixture = await commandFixture(root, "prepared-held-tail", storage)
			const { task, host, provider } = fixture
			const surface = createTaskToolSurface({
				schemas: getNativeTools(),
				mode: "code",
				cwd: root,
				execution: { workspaceRoots: [root] },
			})
			const effects = vi.fn()
			const events: string[] = []
			scheduler = new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
				executionMode: "selective-parallel",
				deferResultCommit: true,
				requirePreparedCommandRead: true,
				onEffectStart: effects,
				onEvent: async (event) => {
					events.push(event.type)
				},
			})
			const heldScheduler = scheduler
			commit = durable.promise.then(async () => {
				events.push("assistant-durable")
				await heldScheduler.commitDeferredResults()
			})
			const outcome = await scheduler.run([
				{
					type: "tool_call",
					id: "held-rg",
					name: "exec_command",
					arguments: {
						cmd: "rg -n HELD_PROOF_ src/held-proof.txt",
						yield_time_ms: 10_000,
						max_output_tokens: 4_096,
					},
				},
			])

			// Baseline fails here at the public admission/effect contract, before any new API is used.
			expect(effects).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "held-rg" }))
			expect(outcome.results.map(({ callId, status, exitCode }) => [callId, status, exitCode])).toEqual([
				["held-rg", "success", 0],
			])
			const outputDir = path.join(await getTaskDirectoryPath(storage, task.taskId), "command-output")
			const artifacts = (await fs.readdir(outputDir)).filter((name) => /^cmd-.*\.txt$/.test(name))
			expect(artifacts).toEqual(["cmd-1001.txt"])
			expect(await fs.readFile(path.join(outputDir, artifacts[0]), "utf8")).toBe(
				lines.map((line, index) => `${index + 1}:${line}\n`).join(""),
			)
			expect(vi.mocked(task.say).mock.calls.filter(([type]) => type === "command_output")).toEqual([])
			expect(provider.postMessageToWebview).not.toHaveBeenCalled()
			expect(task.completeCommandExecution).not.toHaveBeenCalled()
			expect(host.userMessageContent).toEqual([])
			expect(events).not.toContain("tool_result")
			expect(host.askApproval).toHaveBeenCalledOnce()
			expect(vi.mocked(host.askApproval!).mock.calls[0].slice(0, 2)).toEqual([
				"command",
				"rg -n HELD_PROOF_ src/held-proof.txt",
			])

			durable.resolve()
			await commit
			await scheduler.commitDeferredResults()
			expect(task.completeCommandExecution).toHaveBeenCalledOnce()
			expect(task.getCommandExecutionEvidence()).toEqual([
				expect.objectContaining({ toolCallId: "held-rg", status: "succeeded", exitCode: 0 }),
			])
			const outputCalls = vi.mocked(task.say).mock.calls.filter(([type]) => type === "command_output")
			expect(outputCalls.filter((args) => args[3] === false)).toHaveLength(1)
			for (const args of outputCalls) expect(args[6]?.commandExecutionId).toBe("1001")
			expect(host.userMessageContent).toEqual([
				expect.objectContaining({ type: "tool_result", tool_use_id: "held-rg", is_error: false }),
			])
			expect(events.filter((type) => type === "tool_result")).toHaveLength(1)
			expect(events.indexOf("assistant-durable")).toBeLessThan(events.indexOf("tool_result"))
			const updates = provider.postMessageToWebview.mock.calls
				.map(([message]) => message)
				.filter((message) => message.type === "commandExecutionStatus")
				.map((message) => JSON.parse(message.text) as CommandExecutionStatus)
			expect(updates.filter(({ status }) => status === "started")).toHaveLength(1)
			expect(updates.filter(({ status }) => status === "exited")).toHaveLength(1)
			for (const update of updates) expect(update.executionId).toBe("1001")
		} finally {
			durable.resolve()
			await commit?.catch(() => undefined)
			await fixture?.dispose()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("returns four real rg inspections in order with four individual approvals", async () => {
		const check = await execa("rg", ["--version"], { reject: false })
		if (check.failed) throw new Error("This host integration test requires rg on PATH")
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-real-command-batch-")))
		let fixture: Awaited<ReturnType<typeof commandFixture>> | undefined
		try {
			await fs.mkdir(path.join(root, "src"))
			await fs.writeFile(path.join(root, "src", "sample.txt"), "needle one\nneedle two\n")
			fixture = await commandFixture(root, "real-command-batch")
			const { task, host, provider, commandOutputOwners } = fixture
			const surface = createTaskToolSurface({ registry: new ToolRegistry(), mode: "code", cwd: root })
			const outcome = await new ToolScheduler({
				executionHost: host,
				registry: surface.registry,
				policy: surface.policy,
				mode: "code",
				executionMode: "selective-parallel",
			}).run(
				["rg --files src", "rg -n one src", "rg -n two src", "rg -l needle src"].map((command, index) => ({
					type: "tool_call" as const,
					id: `read-${index}`,
					name: "execute_command",
					arguments: { command },
				})),
			)
			expect(outcome.results.map(({ status, exitCode }) => [status, exitCode])).toEqual(
				Array.from({ length: 4 }, () => ["success", 0]),
			)
			expect(outcome.results.map(({ callId }) => callId)).toEqual(["read-0", "read-1", "read-2", "read-3"])
			expect(host.askApproval).toHaveBeenCalledTimes(4)
			expect(task.completeCommandExecution).toHaveBeenCalledTimes(4)
			expect(
				task
					.getCommandExecutionEvidence()
					.map(({ toolCallId, status, exitCode }) => [toolCallId, status, exitCode]),
			).toEqual(["read-0", "read-1", "read-2", "read-3"].map((id) => [id, "succeeded", 0]))
			expect(provider.reservePrimaryMutation).toHaveBeenCalledTimes(4)
			expect(provider.releasePrimaryMutation).toHaveBeenCalledTimes(4)
			expect(provider.recordPrimaryMutation).not.toHaveBeenCalled()
			const approvalRows = task.alphaMessages.filter(
				(message) => message.type === "ask" && message.ask === "command",
			)
			const approvalIds = approvalRows.map(({ ts }) => ts.toString())
			expect(approvalIds).toEqual(["1001", "1002", "1003", "1004"])
			const outputCalls = vi.mocked(task.say).mock.calls.filter((args) => args[0] === "command_output")
			expect(outputCalls.length).toBeGreaterThanOrEqual(4)
			expect(commandOutputOwners).toHaveLength(outputCalls.length)
			expect(outputCalls.filter((args) => args[3] === false).map((args) => args[6]?.commandExecutionId)).toEqual(
				approvalIds,
			)
			for (const [index, args] of outputCalls.entries()) {
				const evidence = task
					.getCommandExecutionEvidence()
					.find(({ toolCallId }) => toolCallId === commandOutputOwners[index])
				const approval = approvalRows.find(({ text }) => text === evidence?.command)
				expect(approval).toBeDefined()
				expect([true, false]).toContain(args[3])
				expect(args[6]?.commandExecutionId).toBe(approval?.ts.toString())
			}
			const updates = provider.postMessageToWebview.mock.calls
				.map(([message]) => message)
				.filter((message) => message.type === "commandExecutionStatus")
				.map((message) => JSON.parse(message.text) as CommandExecutionStatus)
			expect(updates.filter(({ status }) => status === "started").map(({ executionId }) => executionId)).toEqual(
				approvalIds,
			)
			expect(updates.filter(({ status }) => status === "exited").map(({ executionId }) => executionId)).toEqual(
				approvalIds,
			)
			for (const update of updates) expect(approvalIds).toContain(update.executionId)
			for (const [index, approval] of approvalRows.entries()) {
				const id = approval.ts.toString()
				expect(
					updates.find((update) => update.status === "started" && update.executionId === id),
				).toMatchObject({ command: approval.text })
				const evidence = task
					.getCommandExecutionEvidence()
					.find(({ toolCallId }) => toolCallId === `read-${index}`)
				expect(evidence?.executionId).toMatch(
					new RegExp(`^${1001 + index}:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`),
				)
				expect(provider.reservePrimaryMutation).toHaveBeenNthCalledWith(index + 1, task, evidence?.executionId)
				expect(provider.releasePrimaryMutation).toHaveBeenNthCalledWith(index + 1, task, evidence?.executionId)
			}
			expect(await fs.readFile(path.join(root, "src", "sample.txt"), "utf8")).toBe("needle one\nneedle two\n")
		} finally {
			try {
				await fixture?.dispose()
			} finally {
				await fs.rm(root, { recursive: true, force: true })
			}
		}
	})

	it("retains distinct artifacts for repeated approved commands without prompt rows at the same clock", async () => {
		const check = await execa("rg", ["--version"], { reject: false })
		if (check.failed) throw new Error("This host integration test requires rg on PATH")
		const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-artifact-clock-")))
		let fixture: Awaited<ReturnType<typeof commandFixture>> | undefined
		let restoreClock: (() => void) | undefined
		try {
			const root = path.join(directory, "workspace")
			const storage = path.join(directory, "storage")
			await fs.mkdir(path.join(root, "src"), { recursive: true })
			for (const marker of ["FIRST", "SECOND"]) {
				await fs.writeFile(
					path.join(root, "src", `${marker.toLowerCase()}.txt`),
					Array.from({ length: 1500 }, (_, index) => `${marker} retained output row ${index}`).join("\n"),
				)
			}
			fixture = await commandFixture(root, "command-artifact-clock", storage, () => "code", false)
			const { task, host, provider } = fixture
			const fixedNow = Date.now()
			const clock = vi.spyOn(Date, "now").mockReturnValue(fixedNow)
			restoreClock = () => clock.mockRestore()
			const surface = createTaskToolSurface({ schemas: getNativeTools(), mode: "code", cwd: root })
			const results = []
			for (const [index, marker] of ["FIRST", "SECOND"].entries()) {
				const outcome = await new ToolScheduler({
					executionHost: host,
					registry: surface.registry,
					policy: surface.policy,
					mode: "code",
					executionMode: "selective-parallel",
				}).run([
					{
						type: "tool_call",
						id: `clock-command-${index}`,
						name: "exec_command",
						arguments: { cmd: `rg -n ${marker} src/${marker.toLowerCase()}.txt` },
					},
				])
				expect(outcome.results).toHaveLength(1)
				expect(outcome.results[0]).toMatchObject({ status: "success", exitCode: 0 })
				results.push(outcome.results[0])
			}
			const artifacts = results.map((result) => result.commandResult?.artifact_id)
			expect(artifacts.every((artifact) => typeof artifact === "string")).toBe(true)
			expect(new Set(artifacts).size).toBe(2)
			const approvals = task.alphaMessages.filter(
				(message) => message.type === "ask" && message.ask === "command",
			)
			expect(approvals.map(({ ts, isAnswered }) => [ts, isAnswered])).toEqual([
				[fixedNow, true],
				[fixedNow + 1, true],
			])
			expect(task.lastMessageTs).toBe(1000)
			expect(artifacts).toEqual(approvals.map(({ ts }) => `cmd-${ts}.txt`))
			const retained = await Promise.all(
				artifacts.map((artifact) =>
					fs.readFile(path.join(storage, "tasks", task.taskId, "command-output", artifact!), "utf8"),
				),
			)
			expect(retained[0]).toContain("FIRST retained output row 1499")
			expect(retained[0]).not.toContain("SECOND retained output")
			expect(retained[1]).toContain("SECOND retained output row 1499")
			expect(retained[1]).not.toContain("FIRST retained output")
			const evidence = task.getCommandExecutionEvidence()
			expect(evidence).toHaveLength(2)
			for (const [index, entry] of evidence.entries()) {
				expect(entry).toMatchObject({ status: "succeeded", exitCode: 0 })
				expect(entry.executionId).toMatch(new RegExp(`^${approvals[index].ts}:[\\da-f-]+$`))
				expect(provider.reservePrimaryMutation).toHaveBeenNthCalledWith(index + 1, task, entry.executionId)
				expect(provider.releasePrimaryMutation).toHaveBeenNthCalledWith(index + 1, task, entry.executionId)
			}
			expect(host.askApproval).toHaveBeenCalledTimes(2)
			expect(provider.recordPrimaryMutation).not.toHaveBeenCalled()
		} finally {
			restoreClock?.()
			try {
				await fixture?.dispose()
			} finally {
				await fs.rm(directory, { recursive: true, force: true })
			}
		}
	})

	it.each(["code", "architect"] as const)(
		"recovers retained ordinary-command output through native artifact reads in %s",
		async (mode) => {
			const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-artifact-")))
			let fixture: Awaited<ReturnType<typeof commandFixture>> | undefined
			try {
				const root = path.join(directory, "workspace")
				const storage = path.join(directory, "storage")
				await fs.mkdir(path.join(root, "src"), { recursive: true })
				const marker = "artifact RETAINED_MIDDLE_MARKER"
				const source = Array.from({ length: 1_500 }, (_, index) =>
					index === 750 ? marker : `artifact row ${index}: retained command output`,
				).join("\n")
				await fs.writeFile(path.join(root, "src", "output.txt"), source)
				let activeMode: "code" | "architect" = "code"
				fixture = await commandFixture(root, "ordinary-command-artifact", storage, () => activeMode)
				const { task, host, state, provider } = fixture
				const surface = () =>
					createTaskToolSurface({
						schemas: getNativeTools({ planMode: activeMode === "architect" }),
						mode: activeMode,
						cwd: root,
						disabledTools: state.disabledTools,
					})
				let sequence = 0
				const run = async (name: "exec_command" | "write_stdin", args: Record<string, unknown>) => {
					const id = `artifact-call-${++sequence}`
					const call = NativeToolCallParser.parseToolCall({ id, name, arguments: JSON.stringify(args) })
					expect(call?.type).toBe("tool_use")
					if (call?.type !== "tool_use") throw new Error("Native artifact workflow call failed to parse")
					const captured = surface()
					const outcome = await new ToolScheduler({
						executionHost: host,
						registry: captured.registry,
						policy: captured.policy,
						mode: activeMode,
						executionMode: "selective-parallel",
					}).run([{ type: "tool_call", id, name: call.name, arguments: call.nativeArgs }])
					expect(outcome.results).toHaveLength(1)
					return outcome.results[0]
				}

				const command = await run("exec_command", { cmd: "rg -n artifact src" })
				expect(command, JSON.stringify(command)).toMatchObject({ status: "success", exitCode: 0 })
				// Retained command output remains readable after the host switches to Plan.
				activeMode = mode
				Object.assign(task, { taskMode: mode })
				expect(task.completeCommandExecution).toHaveBeenCalledOnce()
				expect(task.getCommandExecutionEvidence()).toEqual([
					expect.objectContaining({
						toolCallId: "artifact-call-1",
						status: "succeeded",
						exitCode: 0,
						executionId: expect.stringMatching(
							/^1001:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
						),
					}),
				])
				expect(provider.reservePrimaryMutation).toHaveBeenCalledOnce()
				expect(provider.releasePrimaryMutation).toHaveBeenCalledOnce()
				expect(provider.recordPrimaryMutation).not.toHaveBeenCalled()
				const artifactId = command.commandResult?.artifact_id
				expect(artifactId).toBe("cmd-1001.txt")
				if (!artifactId) throw new Error("Expected the ordinary collector's persisted output artifact")
				const artifactDirectory = path.join(storage, "tasks", task.taskId, "command-output")
				const retained = await fs.readFile(path.join(artifactDirectory, artifactId), "utf8")
				expect(retained).toContain(marker)
				expect(String(command.content)).not.toContain(marker)
				const guidance = String(command.content).match(/Read artifact (\S+) with (\w+) using (\{[^\n]*\})\./)
				expect.soft(guidance?.[1]).toBe(artifactId)
				expect.soft(guidance?.[2]).toBe("write_stdin")
				const args = guidance
					? (JSON.parse(guidance[3]) as Record<string, unknown>)
					: { artifact_id: artifactId }
				expect(args).toEqual({ artifact_id: artifactId })

				const search = await run("write_stdin", { ...args, search: marker, limit: 1_024 })
				expect(search).toMatchObject({ status: "success", content: expect.stringContaining(marker) })
				expect(Buffer.byteLength(String(search.content))).toBeLessThanOrEqual(1_024)
				const first = await run("write_stdin", { ...args, limit: 512 })
				expect(first).toMatchObject({ status: "success", content: expect.stringContaining("artifact row 0") })
				expect(first.content).not.toContain(marker)
				expect(Buffer.byteLength(String(first.content))).toBeLessThanOrEqual(512)
				const readUi = vi.mocked(task.say).mock.calls.at(-1)?.[1]
				const cursor = JSON.parse(String(readUi)).nextOffset as number
				expect(cursor).toBeGreaterThan(0)
				expect(cursor).toBeLessThan(Buffer.byteLength(retained))
				const next = await run("write_stdin", { ...args, offset: cursor, limit: 512 })
				expect(next.status).toBe("success")
				expect(Buffer.byteLength(String(next.content))).toBeLessThanOrEqual(512)
				expect(next.content).not.toEqual(first.content)
				const offset = Buffer.byteLength(retained.slice(0, retained.indexOf(marker)))
				const middle = await run("write_stdin", { ...args, offset, limit: 512 })
				expect(middle).toMatchObject({ status: "success", content: expect.stringContaining(marker) })

				const numericArtifactId = "cmd-1706119234567.txt"
				await fs.copyFile(
					path.join(artifactDirectory, artifactId),
					path.join(artifactDirectory, numericArtifactId),
				)
				const historical = await run("write_stdin", {
					artifact_id: numericArtifactId,
					search: marker,
					limit: 1_024,
				})
				expect(historical).toMatchObject({ status: "success", content: expect.stringContaining(marker) })
				const uuidArtifactId = "cmd-12345678-1234-4123-8123-123456789abc.txt"
				await fs.copyFile(
					path.join(artifactDirectory, artifactId),
					path.join(artifactDirectory, uuidArtifactId),
				)
				const historicalUuid = await run("write_stdin", {
					artifact_id: uuidArtifactId,
					search: marker,
					limit: 1_024,
				})
				expect(historicalUuid).toMatchObject({ status: "success", content: expect.stringContaining(marker) })
				expect(host.userMessageContent).toHaveLength(7)
				expect(host.userMessageContent.every((item) => item.type === "tool_result" && !item.is_error)).toBe(
					true,
				)
				expect(host.askApproval).toHaveBeenCalledTimes(1)

				const originalTaskId = task.taskId
				Object.assign(task, { taskId: "other-task" })
				const foreign = await run("write_stdin", args)
				expect(foreign).toMatchObject({
					status: "error",
					content: expect.stringContaining("Artifact not found"),
				})
				expect(foreign.content).not.toContain(marker)
				Object.assign(task, { taskId: originalTaskId })
				state.disabledTools = ["write_stdin"]
				const disabled = await run("write_stdin", args)
				expect(disabled.status).not.toBe("success")
				expect(disabled.content).not.toContain(marker)
			} finally {
				try {
					await fixture?.dispose()
				} finally {
					await fs.rm(directory, { recursive: true, force: true })
				}
			}
		},
	)
})
