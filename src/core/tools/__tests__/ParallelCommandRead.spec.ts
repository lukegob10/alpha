import fs from "fs/promises"
import os from "os"
import path from "path"
import { execa } from "execa"
import type { Task } from "../../task/Task"
import type { ToolExecutionContext } from "../ToolRegistry"
import { createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { classifyCommandRead, prepareParallelCommand } from "../ParallelCommandRead"

const { getBinPathMock } = vi.hoisted(() => ({
	getBinPathMock: vi.fn(),
}))

vi.mock("execa", () => ({ execa: vi.fn() }))
vi.mock("../../../services/ripgrep", () => ({ getBinPath: getBinPathMock }))

describe("isolated command reads", () => {
	let directory: string
	let root: string
	let bundledRipgrep: string
	let context: ToolExecutionContext
	let state: { disabledTools: string[]; allowedCommands: string[]; deniedCommands: string[] }
	const policy = createToolPolicySnapshot({ visibleTools: ["execute_command"] })

	beforeEach(async () => {
		vi.clearAllMocks()
		directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-command-read-")))
		root = path.join(directory, "workspace")
		await fs.mkdir(path.join(root, ".git"), { recursive: true })
		await fs.mkdir(path.join(root, "src"))
		await fs.writeFile(path.join(root, "src", "example.ts"), "const needle = 1")
		const bin = path.join(directory, "bin")
		await fs.mkdir(bin)
		bundledRipgrep = path.join(directory, "bundled", process.platform === "win32" ? "rg.exe" : "rg")
		await fs.mkdir(path.dirname(bundledRipgrep), { recursive: true })
		await fs.writeFile(bundledRipgrep, "")
		getBinPathMock.mockResolvedValue(bundledRipgrep)
		for (const name of ["git", "rg"])
			await fs.writeFile(path.join(bin, process.platform === "win32" ? `${name}.exe` : name), "")
		for (const key of Object.keys(process.env))
			if (/^GIT_|^RIPGREP_CONFIG_PATH$/i.test(key)) vi.stubEnv(key, undefined)
		vi.stubEnv(Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH", bin)
		state = { disabledTools: [], allowedCommands: [], deniedCommands: [] }
		const provider = { getValues: () => state, postMessageToWebview: vi.fn(), context: {} }
		const task = {
			taskId: "command-read",
			taskKind: "primary",
			cwd: root,
			abort: false,
			taskMode: "code",
			getTaskMode: async () => "code",
			providerRef: { deref: () => provider },
			lastMessageTs: 123,
			clineMessages: [{ ts: 123, type: "ask", ask: "command", text: "git status --short" }],
			recordCommandInspectionResult: vi.fn(),
			beginCommandExecution: vi.fn(),
			completeCommandExecution: vi.fn(),
			failCommandExecution: vi.fn(),
			say: vi.fn(),
			alphaIgnoreController: { validateCommand: () => undefined },
		} as unknown as Task
		context = {
			task,
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
				handleError: vi.fn(),
				pushToolResult: vi.fn(),
				setResultMetadata: vi.fn(),
			},
		}
		vi.mocked(execa).mockResolvedValue({
			all: "result",
			exitCode: 0,
			failed: false,
			timedOut: false,
			isCanceled: false,
		} as never)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await fs.rm(directory, { recursive: true, force: true })
	})

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
	])("admits independent inspection %s", async (command) => {
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
	])("keeps unsupported or effectful command serial: %s", async (command) => {
		expect(await classifyCommandRead(command, root, root)).toBeUndefined()
	})

	it("approves before starting and publishes evidence and output only after joining", async () => {
		const read = await prepareParallelCommand(context, policy)
		expect(read).toBeDefined()
		expect(context.callbacks.askApproval).toHaveBeenCalledExactlyOnceWith(
			"command",
			"git status --short",
			undefined,
		)
		expect(execa).toHaveBeenCalledTimes(1)
		const finalize = await read!.run!(context.callbacks)
		expect(execa).toHaveBeenCalledWith(
			expect.stringContaining("git"),
			expect.arrayContaining(["--no-optional-locks", "--no-lazy-fetch", "core.fsmonitor=false"]),
			expect.objectContaining({
				shell: false,
				stdin: "ignore",
				windowsHide: true,
				maxBuffer: 1_048_576,
				timeout: 60_000,
			}),
		)
		expect(context.task.say).not.toHaveBeenCalled()
		expect(context.task.beginCommandExecution).not.toHaveBeenCalled()
		expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith(
			expect.objectContaining({ status: "success", exitCode: 0, trustedExploration: expect.any(Object) }),
		)
		await finalize()
		expect(context.task.recordCommandInspectionResult).toHaveBeenCalledWith(
			expect.objectContaining({ toolCallId: "call-1", exitCode: 0, status: "succeeded", cwd: root }),
		)
		expect(context.task.say).toHaveBeenCalledWith(
			"command_output",
			expect.stringContaining("result"),
			undefined,
			undefined,
			undefined,
			undefined,
			{ isNonInteractive: true, commandExecutionId: "123" },
		)
	})

	it("prepares an exec_command rg read from its native cmd and workdir fields", async () => {
		const command = "rg -n needle src"
		context.call = {
			...context.call,
			name: "exec_command",
			nativeArgs: { cmd: command, workdir: ".", yield_time_ms: 10_000 },
		}

		const read = await prepareParallelCommand(context, policy)

		expect(read).toMatchObject({ scope: root })
		expect(context.callbacks.askApproval).toHaveBeenCalledExactlyOnceWith("command", command, { text: root })
		const finalize = await read!.run!(context.callbacks)
		expect(execa).toHaveBeenCalledWith(
			expect.stringContaining("rg"),
			expect.arrayContaining(["--no-config", "-n", "needle", "src"]),
			expect.objectContaining({ cwd: root, timeout: 10_000, shell: false }),
		)
		await finalize()
	})

	it("uses the extension-bundled ripgrep when rg is absent from PATH", async () => {
		context.call = {
			...context.call,
			name: "exec_command",
			nativeArgs: { cmd: "rg -n needle src" },
		}
		vi.stubEnv(Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH", "")

		const read = await prepareParallelCommand(context, policy)

		expect(read).toMatchObject({ scope: root })
		expect(getBinPathMock).toHaveBeenCalled()
		const finalize = await read!.run!(context.callbacks)
		expect(execa).toHaveBeenCalledWith(
			bundledRipgrep,
			expect.arrayContaining(["--no-config", "-n", "needle", "src"]),
			expect.objectContaining({ cwd: root, shell: false }),
		)
		await finalize()
	})

	it("allows isolated rg reads when only an unrelated Git environment setting is present", async () => {
		context.call = {
			...context.call,
			name: "exec_command",
			nativeArgs: { cmd: "rg -n needle src" },
		}
		vi.stubEnv("GIT_PAGER", "custom")

		const read = await prepareParallelCommand(context, policy)

		expect(read).toMatchObject({ scope: root })
		const finalize = await read!.run!(context.callbacks)
		expect(execa).toHaveBeenCalledExactlyOnceWith(
			expect.any(String),
			expect.arrayContaining(["--no-config", "-n", "needle", "src"]),
			expect.objectContaining({ cwd: root, shell: false }),
		)
		await finalize()
	})

	it("keeps non-read exec_command calls on the ordinary path without approval or process start", async () => {
		context.call = {
			...context.call,
			name: "exec_command",
			nativeArgs: { cmd: "node -e \\\"require('fs').writeFileSync('unsafe.txt', 'x')\\\"" },
		}

		expect(await prepareParallelCommand(context, policy)).toBeUndefined()
		expect(context.callbacks.askApproval).not.toHaveBeenCalled()
		expect(execa).not.toHaveBeenCalled()
	})

	it("rechecks changed approval for native exec_command before starting the read process", async () => {
		context.call = {
			...context.call,
			name: "exec_command",
			nativeArgs: { cmd: "rg -n needle src" },
		}
		const read = await prepareParallelCommand(context, policy)
		expect(read).toBeDefined()

		state.deniedCommands.push("rg")
		await expect(read!.run!(context.callbacks)).rejects.toThrow("approval or read scope changed")
		expect(execa).not.toHaveBeenCalled()
	})

	it("associates output with the command approval when approval feedback follows it", async () => {
		context.task.clineMessages.push({ ts: 124, type: "say", say: "user_feedback", text: "Proceed" })
		Object.defineProperty(context.task, "lastMessageTs", { value: 124 })
		const read = await prepareParallelCommand(context, policy)
		const finalize = await read!.run!(context.callbacks)
		await finalize()
		expect(context.task.say).toHaveBeenCalledWith(
			"command_output",
			expect.any(String),
			undefined,
			undefined,
			undefined,
			undefined,
			{ isNonInteractive: true, commandExecutionId: "123" },
		)
	})

	it("does not launch a denied command", async () => {
		vi.mocked(context.callbacks.askApproval).mockResolvedValue(false)
		expect(await prepareParallelCommand(context, policy)).toBeUndefined()
		expect(execa).not.toHaveBeenCalled()
	})

	it("falls back for unsupported Git and remembers the binary capability without another probe", async () => {
		vi.mocked(execa).mockResolvedValueOnce({ failed: true, exitCode: 129, stderr: "unknown option" } as never)
		const read = await prepareParallelCommand(context, policy)
		expect(read).toEqual({ scope: root, serialFallback: true })
		expect(execa).toHaveBeenCalledTimes(1)
		expect(await prepareParallelCommand(context, policy)).toBeUndefined()
		expect(context.callbacks.askApproval).toHaveBeenCalledTimes(1)
		expect(execa).toHaveBeenCalledTimes(1)
	})

	it.each(["mode", "disabled", "rule", "ignore"])(
		"revalidates %s after approval and before launch",
		async (change) => {
			const read = await prepareParallelCommand(context, policy)
			if (change === "mode") Object.defineProperty(context.task, "taskMode", { value: "architect" })
			if (change === "disabled") state.disabledTools.push("execute_command")
			if (change === "rule") state.deniedCommands.push("git")
			if (change === "ignore") context.task.alphaIgnoreController = undefined
			await expect(read!.run!(context.callbacks)).rejects.toThrow("approval or read scope changed")
			expect(execa).toHaveBeenCalledTimes(1)
		},
	)

	it.each(["RIPGREP_CONFIG_PATH", "GIT_CONFIG_PARAMETERS", "GIT_TRACE", "GIT_REDIRECT_STDOUT", "GIT_PAGER"])(
		"keeps environment-configured %s commands serial",
		async (key) => {
			vi.stubEnv(key, "custom")
			if (key === "RIPGREP_CONFIG_PATH") {
				context.call.nativeArgs = { command: "rg -n needle src" }
			}
			expect(await prepareParallelCommand(context, policy)).toBeUndefined()
			expect(context.callbacks.askApproval).not.toHaveBeenCalled()
			expect(execa).not.toHaveBeenCalled()
		},
	)

	it.each([
		{ failed: true, exitCode: 2, timedOut: false, isCanceled: false, status: "error" },
		{ failed: true, exitCode: undefined, timedOut: true, isCanceled: false, status: "error" },
		{ failed: true, exitCode: undefined, timedOut: false, isCanceled: true, status: "cancelled" },
	])("preserves process failure $status / timeout $timedOut", async ({ status, ...result }) => {
		vi.mocked(execa).mockResolvedValue({ all: "failure details", ...result } as never)
		vi.mocked(execa).mockResolvedValueOnce({ failed: false, exitCode: 0, stdout: "git version" } as never)
		const read = await prepareParallelCommand(context, policy)
		const finalize = await read!.run!(context.callbacks)
		expect(context.callbacks.setResultMetadata).toHaveBeenCalledWith(
			expect.objectContaining({ status, exitCode: result.exitCode, timedOut: result.timedOut }),
		)
		await finalize()
		expect(context.task.providerRef.deref()?.postMessageToWebview).toHaveBeenCalledWith({
			type: "commandExecutionStatus",
			text: JSON.stringify(
				result.timedOut
					? { executionId: "123", status: "timeout" }
					: { executionId: "123", status: "exited", exitCode: result.exitCode },
			),
		})
		if (status === "cancelled")
			expect(context.task.recordCommandInspectionResult).toHaveBeenCalledWith(
				expect.objectContaining({ toolCallId: "call-1", status: "cancelled" }),
			)
	})
})
