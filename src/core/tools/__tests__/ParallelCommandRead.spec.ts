import fs from "fs/promises"
import os from "os"
import path from "path"
import { execa } from "execa"
import { Task, type CommandExecutionEvidence } from "../../task/Task"
import { ToolRegistry, type ToolExecutionContext } from "../ToolRegistry"
import { createTaskToolSurface } from "../TaskToolSurface"
import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { classifyCommandRead, isParallelCommandReadReady } from "../ParallelCommandRead"
import { AlphaIgnoreController } from "../../ignore/AlphaIgnoreController"
import { AlphaProtectedController } from "../../protect/AlphaProtectedController"
import { TerminalRegistry } from "../../../integrations/terminal/TerminalRegistry"

const platform = vi.hoisted(() => ({ resolveRipgrep: vi.fn() }))
vi.mock("../../../services/ripgrep", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../services/ripgrep")>()),
	resolveRipgrepBinary: platform.resolveRipgrep,
}))
vi.mock("vscode", async (importOriginal) => ({
	...(await importOriginal<typeof import("vscode")>()),
	RelativePattern: class {
		constructor(
			readonly base: string,
			readonly pattern: string,
		) {}
	},
}))

vi.mock("execa", () => ({ execa: vi.fn(), ExecaError: class extends Error {} }))

describe("command-read classification and session execution boundary", () => {
	let directory: string
	let root: string
	let context: ToolExecutionContext
	let executable: string
	let replaceProvider: () => void
	const policy = createToolPolicySnapshot({ visibleTools: ["execute_command"] })

	beforeEach(async () => {
		vi.clearAllMocks()
		for (const key of [
			"RIPGREP_CONFIG_PATH",
			"GIT_CONFIG_PARAMETERS",
			"GIT_TRACE",
			"GIT_REDIRECT_STDOUT",
			"GIT_PAGER",
		]) {
			vi.stubEnv(key, undefined)
		}
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-read-")))
		root = path.join(directory, "workspace")
		await fs.mkdir(path.join(root, ".git"), { recursive: true })
		await fs.mkdir(path.join(root, "src"))
		await fs.writeFile(path.join(root, "src", "example.ts"), "const needle = 1")
		executable = path.join(directory, process.platform === "win32" ? "rg.exe" : "rg")
		await fs.writeFile(executable, "controlled trusted executable metadata\n")
		await fs.chmod(executable, 0o755)
		platform.resolveRipgrep.mockResolvedValue({
			path: executable,
			source: "bundled",
			reason: "unit platform fixture",
		})
		const ignoreController = new AlphaIgnoreController(root)
		await ignoreController.initialize()
		const provider = { getState: async () => ({}), getValues: () => ({}), postMessageToWebview: vi.fn() }
		const lifetime = new AbortController()
		let currentProvider = provider
		replaceProvider = () => {
			currentProvider = { ...provider }
		}
		const task = {
			taskId: "command-read",
			cwd: root,
			taskMode: "code",
			getTaskMode: async () => "code",
			getTaskLifetimeCancellationSignal: () => lifetime.signal,
			providerRef: { deref: () => currentProvider },
			abort: false,
			clineMessages: [],
			commandExecutionEvidence: new Map<string, CommandExecutionEvidence>(),
			pendingCommandVerification: Promise.resolve(),
			completionRuntimeRevision: 0,
			beginCommandExecution: Task.prototype.beginCommandExecution,
			admitCommandExecution: Task.prototype.admitCommandExecution,
			completeCommandExecution: Task.prototype.completeCommandExecution,
			failCommandExecution: Task.prototype.failCommandExecution,
			getCommandExecutionEvidence: Task.prototype.getCommandExecutionEvidence,
			prepareCommandEvidenceSlot: Task.prototype["prepareCommandEvidenceSlot"],
			enqueueCommandEvidence: Task.prototype["enqueueCommandEvidence"],
			publishParentVerificationEvidence: vi.fn(),
			recordToolError: vi.fn(),
			recordCommandInspectionResult: vi.fn(),
			say: vi.fn(),
			alphaIgnoreController: ignoreController,
			alphaProtectedController: new AlphaProtectedController(root),
		} as unknown as Task
		context = {
			task,
			mode: "code",
			call: {
				id: "call-1",
				name: "execute_command",
				type: "tool_use",
				params: {},
				partial: false,
				nativeArgs: { command: "git status --short" },
			},
			callbacks: {
				toolCallId: "call-1",
				askApproval: vi.fn(async () => true),
				askCommandApproval: vi.fn(async (_type, command) => {
					task.clineMessages.push({ ts: 1_001, type: "ask", ask: "command", text: command })
					return { approved: true, commandExecutionId: "1001" }
				}),
				handleError: vi.fn(),
				pushToolResult: vi.fn(),
				setResultMetadata: vi.fn(),
			},
		}
	})

	afterEach(async () => {
		context.task.alphaIgnoreController?.dispose()
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
		TerminalRegistry.releaseTerminalsForTask(context.task.taskId)
		await fs.rm(directory, { recursive: true, force: true })
	})

	function native(command = "rg -n needle src/example.ts", extra: Record<string, unknown> = {}) {
		const args = { cmd: command, ...extra }
		context.call = { ...context.call, name: "exec_command", nativeArgs: args } as ToolExecutionContext["call"]
		return {
			args,
			policy: createToolPolicySnapshot({ visibleTools: ["exec_command"], execution: { workspaceRoots: [root] } }),
		}
	}

	function prepareWithRegistry(context: ToolExecutionContext, capturedPolicy: typeof policy) {
		const descriptor = new ToolRegistry().resolve(context.call.name)
		if (!descriptor?.prepareParallelCommand) throw new Error("Command read descriptor is unavailable")
		return descriptor.prepareParallelCommand(context, capturedPolicy)
	}

	it.each([undefined, false])(
		"admits a trusted explicit-file rg pipe with tty=%s without spawning during preparation",
		async (tty) => {
			const { args, policy: capturedPolicy } = native(
				"rg -n needle src/example.ts",
				tty === undefined ? {} : { tty },
			)
			expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(true)
			const surface = createTaskToolSurface({
				registry: new ToolRegistry(),
				mode: "code",
				cwd: root,
				applyProfile: false,
				execution: { workspaceRoots: [root] },
			})
			expect(
				await Task.prototype["isPreEofReadonlyToolCall"].call(
					context.task,
					{
						type: "tool_call",
						id: "ready-native",
						name: "exec_command",
						arguments: args,
					},
					surface,
				),
			).toBe(true)
			expect(context.callbacks.askCommandApproval).not.toHaveBeenCalled()
			const prepared = await prepareWithRegistry(context, capturedPolicy)
			try {
				expect(prepared?.scope).toBe(root)
				expect(prepared?.run).toBeTypeOf("function")
				expect(context.callbacks.askCommandApproval).toHaveBeenCalledOnce()
				expect(context.callbacks.askApproval).not.toHaveBeenCalled()
				expect(context.task.say).not.toHaveBeenCalled()
				expect(execa).not.toHaveBeenCalled()
			} finally {
				await prepared?.dispose?.()
			}
		},
	)

	it("allows the exact explicit target while a real nonempty ignore policy blocks an rg directory traversal", async () => {
		await fs.writeFile(path.join(root, ".alphaignore"), "src/hidden.txt\n")
		await fs.writeFile(path.join(root, "src", "hidden.txt"), "needle hidden")
		await context.task.alphaIgnoreController!.initialize()
		const { args, policy: capturedPolicy } = native()
		expect(context.task.alphaIgnoreController!.validateAccess("src/hidden.txt")).toBe(false)
		expect(context.task.alphaIgnoreController!.validateCommand("rg -n needle src")).toBeUndefined()
		expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(true)
		expect(await isParallelCommandReadReady(context.task, { cmd: "rg -n needle src" }, capturedPolicy)).toBe(false)
		context.call = { ...context.call, nativeArgs: { cmd: "rg -n needle src" } } as ToolExecutionContext["call"]
		expect(await prepareWithRegistry(context, capturedPolicy)).toBeUndefined()
		expect(context.callbacks.askCommandApproval).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	it.each(["src/hidden.txt", "AGENTS.md"])(
		"does not admit the ignored or protected explicit target %s",
		async (target) => {
			await fs.writeFile(path.join(root, ".alphaignore"), "src/hidden.txt\n")
			await fs.writeFile(path.join(root, target), "needle protected or ignored")
			await context.task.alphaIgnoreController!.initialize()
			const { args, policy: capturedPolicy } = native(`rg -n needle ${target}`)
			expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(false)
			expect(await prepareWithRegistry(context, capturedPolicy)).toBeUndefined()
			expect(context.callbacks.askCommandApproval).not.toHaveBeenCalled()
			expect(execa).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ label: "ignored positional file before -e", command: "rg .env -e secret src/example.ts" },
		{ label: "protected positional file before --regexp", command: "rg AGENTS.md --regexp secret src/example.ts" },
	])("does not omit an $label from admission", async ({ command }) => {
		await fs.writeFile(path.join(root, ".alphaignore"), ".env\n")
		await fs.writeFile(path.join(root, ".env"), "secret ignored")
		await fs.writeFile(path.join(root, "AGENTS.md"), "secret protected")
		await context.task.alphaIgnoreController!.initialize()
		const { args, policy: capturedPolicy } = native(command)
		expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(false)
		expect(await prepareWithRegistry(context, capturedPolicy)).toBeUndefined()
		expect(context.callbacks.askCommandApproval).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	it("preserves an explicit dash-prefixed file after the rg option terminator", async () => {
		await fs.writeFile(path.join(root, "-e"), "needle literal filename")
		const { args, policy: capturedPolicy } = native("rg -e needle -- -e")
		expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(true)
		const prepared = await prepareWithRegistry(context, capturedPolicy)
		try {
			expect(prepared?.run).toBeTypeOf("function")
			expect(execa).not.toHaveBeenCalled()
		} finally {
			await prepared?.dispose?.()
		}
	})

	it.each([
		"rg -n needle .",
		"rg --files src",
		"rg -n needle",
		"rg --glob '*.ts' needle src/example.ts",
		"rg -n needle -",
	])("keeps unaudited traversal or argv on the ordinary path: %s", async (command) => {
		const { args, policy: capturedPolicy } = native(command)
		expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(false)
		expect(await prepareWithRegistry(context, capturedPolicy)).toBeUndefined()
		expect(context.callbacks.askCommandApproval).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	it("bounds the prepared regular-file target set before approval", async () => {
		const targets = Array.from({ length: 17 }, (_, index) => `src/bounded-${index}.txt`)
		await Promise.all(targets.map((target) => fs.writeFile(path.join(root, target), "needle")))
		const { args, policy: capturedPolicy } = native(`rg -n needle ${targets.join(" ")}`)
		expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(false)
		expect(await prepareWithRegistry(context, capturedPolicy)).toBeUndefined()
		expect(context.callbacks.askCommandApproval).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	it.each([
		{ label: "PTY", extra: { tty: true } },
		{ label: "shell", extra: { shell: "bash" } },
		{ label: "login", extra: { login: true } },
		{ label: "verification", extra: { verification: { change_set_ids: ["change"] } } },
	])("does not convert unsupported $label semantics into an audited pipe", async ({ extra }) => {
		const { args, policy: capturedPolicy } = native(undefined, extra)
		expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(false)
		expect(await prepareWithRegistry(context, capturedPolicy)).toBeUndefined()
		expect(context.callbacks.askCommandApproval).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	it.each(["system", "workspace", "missing", "configured environment"])(
		"falls back before approval for %s executable capability",
		async (kind) => {
			if (kind === "system") platform.resolveRipgrep.mockResolvedValue({ path: executable, source: "system" })
			if (kind === "workspace") {
				const inWorkspace = path.join(root, process.platform === "win32" ? "rg.exe" : "rg")
				await fs.copyFile(executable, inWorkspace)
				platform.resolveRipgrep.mockResolvedValue({ path: inWorkspace, source: "bundled" })
			}
			if (kind === "missing") await fs.unlink(executable)
			if (kind === "configured environment")
				vi.stubEnv("RIPGREP_CONFIG_PATH", path.join(directory, "injected-config"))
			const { args, policy: capturedPolicy } = native()
			expect(await isParallelCommandReadReady(context.task, args, capturedPolicy)).toBe(false)
			expect(await prepareWithRegistry(context, capturedPolicy)).toBeUndefined()
			expect(context.callbacks.askCommandApproval).not.toHaveBeenCalled()
			expect(execa).not.toHaveBeenCalled()
		},
	)

	it.each(["environment", "executable", "scope", "ignore", "mode", "provider", "authority"])(
		"revalidates captured %s after approval before launching the shared collector",
		async (kind) => {
			const { policy: capturedPolicy } = native()
			const prepared = await prepareWithRegistry(context, capturedPolicy)
			try {
				expect(prepared?.run).toBeTypeOf("function")
				if (!prepared?.run) return
				if (kind === "environment") vi.stubEnv("ALPHA_PREPARED_REVALIDATION", "changed after approval")
				if (kind === "executable")
					await fs.writeFile(executable, "replacement executable with a different identity and size")
				if (kind === "scope") {
					const outside = path.join(directory, "outside")
					await fs.mkdir(outside)
					await fs.writeFile(path.join(outside, "example.ts"), "needle outside")
					await fs.rename(path.join(root, "src"), path.join(root, "old-src"))
					await fs.symlink(outside, path.join(root, "src"), process.platform === "win32" ? "junction" : "dir")
				}
				if (kind === "ignore") {
					await fs.writeFile(path.join(root, ".alphaignore"), "src/example.ts\n")
					await context.task.alphaIgnoreController!.initialize()
				}
				if (kind === "mode") context.task.getTaskMode = async () => "architect"
				if (kind === "provider") replaceProvider()
				if (kind === "authority")
					context.task.getTaskCommandDenialReason = () => "Task command authority was revoked"
				const observed = await prepared.run(context.callbacks).then(
					async (finalize) => {
						await finalize()
						return { status: "fulfilled" as const }
					},
					(reason) => ({ status: "rejected" as const, reason }),
				)
				if (observed.status === "rejected") {
					expect(String(observed.reason)).toMatch(/Prepared command/)
				}
				expect(execa).not.toHaveBeenCalled()
				expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith(
					expect.objectContaining({ status: expect.stringMatching(/error|denied/) }),
				)
				if (kind === "ignore" || kind === "authority") {
					expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith(
						expect.objectContaining({
							status: "denied",
							failure: expect.objectContaining({
								reason: "policy_denied",
								effectsStarted: "no",
								outcome: "known",
								recovery: { kind: "user-action" },
							}),
						}),
					)
				}
			} finally {
				await prepared?.dispose?.()
			}
		},
	)

	it.each([
		"git status --short",
		"git diff --stat",
		"git --no-pager diff --no-ext-diff --no-textconv -- src/example.ts",
		"git show HEAD:src/example.ts",
		"git log -n 5 --oneline",
		"git ls-files --stage",
		"git ls-tree -r HEAD",
		"git rev-parse --verify HEAD",
		"rg -n needle src",
		"rg --files src",
		"rg -n -e 'needle|other' src",
	])("recognizes a conservative read without granting execution: %s", async (command) => {
		expect(await classifyCommandRead(command, root, root)).toBeDefined()
	})

	it.each([
		"git reset --hard",
		"gh pr list",
		"gh pr create --fill",
		"gh api repos/owner/repo/issues",
		"gh api graphql -f query=mutation",
		"gh alias set shortcut '!echo changed'",
		"gh extension exec custom",
		"git pull",
		"git diff --output=out.txt",
		"git -c alias.status=anything status",
		"git diff --ext-diff",
		"git show --textconv HEAD:src/example.ts",
		"git log --show-signature",
		"git status; git reset --hard",
		"git diff --no-index ../outside src",
		"git cat-file --filters HEAD:x",
		"rg --pre processor needle src",
		"rg --follow needle src",
		"rg -f patterns src",
		"rg -n needle ../outside",
		"rg -n needle src > results",
		"git diff --output out.txt",
		"git status $(whoami)",
		"git.cmd status",
	])("does not classify unsupported or effectful commands as safe reads: %s", async (command) => {
		expect(await classifyCommandRead(command, root, root)).toBeUndefined()
	})

	it.each([
		"git status --short --untracked-files=all",
		"git diff -- README.md lib/cart.cjs",
		"git diff --cached -- README.md",
		"git ls-files --others --exclude-standard",
	])("waits for provider EOF and ordinary policy handling for %s", async (command) => {
		const surface = createTaskToolSurface({
			registry: new ToolRegistry(),
			mode: "code",
			applyProfile: false,
			execution: { workspaceRoots: [root] },
		})
		const call = {
			type: "tool_call" as const,
			id: "native-read",
			name: "exec_command",
			arguments: { cmd: command, workdir: root, yield_time_ms: 10_000, max_output_tokens: 2_000 },
		}
		expect(await prepareWithRegistry(context, surface.policy)).toBeUndefined()
		expect(await Task.prototype["isPreEofReadonlyToolCall"].call(context.task, call, surface)).toBe(false)
		context.task.alphaIgnoreController!.alphaIgnoreContent = ".alpha-development-*\n.alpha-e2e-owned.json\n"
		expect(await Task.prototype["isPreEofReadonlyToolCall"].call(context.task, call, surface)).toBe(false)
		expect(context.callbacks.askApproval).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	// Yield deadlines, output budgets, nonzero numeric exits, cancellation, and
	// session publication belong to the ordinary executor's existing regressions.
	it.each([
		{ name: "exec_command", args: { cmd: "git diff --exit-code", yield_time_ms: 10_000, max_output_tokens: 0 } },
		{ name: "exec_command", args: { cmd: "rg -n needle src", tty: true, max_output_tokens: 1 } },
		{ name: "execute_command", args: { command: "git diff --exit-code", timeout: 10 } },
		{ name: "shell", args: { command: "rg -n needle src", timeout: 10 } },
	])("routes $name through the session executor before approval or process launch", async ({ name, args }) => {
		context.call = { ...context.call, name, nativeArgs: args } as ToolExecutionContext["call"]
		expect(await isParallelCommandReadReady(context.task, args, policy)).toBe(false)
		expect(await prepareWithRegistry(context, policy)).toBeUndefined()
		expect(context.callbacks.askApproval).not.toHaveBeenCalled()
		expect(context.callbacks.pushToolResult).not.toHaveBeenCalled()
		expect(context.task.recordCommandInspectionResult).not.toHaveBeenCalled()
		expect(context.task.say).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	it("falls back before filesystem or executable capability inspection", async () => {
		const realpath = vi
			.spyOn(fs, "realpath")
			.mockRejectedValue(new Error("Unexpected isolated execution preflight"))
		expect(await prepareWithRegistry(context, policy)).toBeUndefined()
		expect(realpath).not.toHaveBeenCalled()
		expect(context.callbacks.askApproval).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	it.each(["relative", "absolute", "junction", "captured-policy"])(
		"defers %s workdir enforcement to the ordinary handler without launching an isolated process",
		async (kind) => {
			const outside = path.join(root, "..", "outside")
			await fs.mkdir(outside)
			const link = path.join(root, "linked-outside")
			if (kind === "junction") await fs.symlink(outside, link, process.platform === "win32" ? "junction" : "dir")
			context.call = {
				...context.call,
				name: "exec_command",
				nativeArgs: {
					cmd: "rg --files .",
					workdir:
						kind === "captured-policy"
							? root
							: kind === "relative"
								? "../outside"
								: kind === "junction"
									? link
									: outside,
				},
			}
			const capturedPolicy =
				kind === "captured-policy"
					? createToolPolicySnapshot({
							visibleTools: ["exec_command"],
							execution: { workspaceRoots: [path.join(root, "src")] },
						})
					: policy
			expect(await prepareWithRegistry(context, capturedPolicy)).toBeUndefined()
			expect(context.callbacks.askApproval).not.toHaveBeenCalled()
			expect(execa).not.toHaveBeenCalled()
		},
	)

	it.each(["RIPGREP_CONFIG_PATH", "GIT_CONFIG_PARAMETERS", "GIT_TRACE", "GIT_REDIRECT_STDOUT", "GIT_PAGER"])(
		"does not probe or execute a separate collector when %s is configured",
		async (key) => {
			vi.stubEnv(key, "custom")
			expect(await prepareWithRegistry(context, policy)).toBeUndefined()
			expect(context.callbacks.askApproval).not.toHaveBeenCalled()
			expect(execa).not.toHaveBeenCalled()
		},
	)
})
