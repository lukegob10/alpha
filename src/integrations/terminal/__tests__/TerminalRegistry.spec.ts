// npx vitest run src/integrations/terminal/__tests__/TerminalRegistry.spec.ts

import * as vscode from "vscode"
import * as path from "node:path"
import { resolveRipgrepBinary } from "../../../services/ripgrep"
import { ExecaTerminal } from "../ExecaTerminal"
import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"

const PAGER = process.platform === "win32" ? "" : "cat"
const windowsShellOptions =
	process.platform === "win32"
		? {
				shellPath: expect.stringMatching(/\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i),
				shellArgs: [],
			}
		: {}

vi.mock("execa", () => ({
	execa: vi.fn(),
}))
vi.mock("../../../services/ripgrep", () => ({ resolveRipgrepBinary: vi.fn() }))

describe("TerminalRegistry", () => {
	let mockCreateTerminal: any

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(resolveRipgrepBinary).mockReset()
		vi.mocked(resolveRipgrepBinary).mockResolvedValue(undefined)
		mockCreateTerminal = vi.spyOn(vscode.window, "createTerminal").mockImplementation(
			(...args: any[]) =>
				({
					exitStatus: undefined,
					name: "Alpha",
					processId: Promise.resolve(123),
					creationOptions: {},
					state: {
						isInteractedWith: true,
						shell: { id: "test-shell", executable: "/bin/bash", args: [] },
					},
					dispose: vi.fn(),
					hide: vi.fn(),
					show: vi.fn(),
					sendText: vi.fn(),
					shellIntegration: {
						executeCommand: vi.fn(),
					},
				}) as any,
		)
	})

	describe("createTerminal", () => {
		it("selects built-in Windows PowerShell for new Alpha terminals", () => {
			const originalPlatform = process.platform
			const systemRoot = process.env.SystemRoot
			Object.defineProperty(process, "platform", { value: "win32" })
			process.env.SystemRoot = "D:\\Windows"
			try {
				const terminal = TerminalRegistry.createTerminal("D:\\project", "vscode")
				expect(terminal).toBeInstanceOf(Terminal)
				expect(mockCreateTerminal).toHaveBeenCalledWith(
					expect.objectContaining({
						shellPath: "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
						shellArgs: [],
					}),
				)
			} finally {
				Object.defineProperty(process, "platform", { value: originalPlatform })
				if (systemRoot === undefined) delete process.env.SystemRoot
				else process.env.SystemRoot = systemRoot
			}
		})

		it("creates terminal with PAGER set appropriately for platform", () => {
			TerminalRegistry.createTerminal("/test/path", "vscode")

			expect(mockCreateTerminal).toHaveBeenCalledWith({
				...windowsShellOptions,
				cwd: "/test/path",
				name: "Alpha",
				iconPath: expect.any(Object),
				env: {
					PAGER,
					ALPHA_ACTIVE: "true",
					VTE_VERSION: "0",
					PROMPT_EOL_MARK: "",
				},
			})
		})

		it("adds PROMPT_COMMAND when Terminal.getCommandDelay() > 0", () => {
			// Set command delay to 50ms for this test
			const originalDelay = Terminal.getCommandDelay()
			Terminal.setCommandDelay(50)

			try {
				TerminalRegistry.createTerminal("/test/path", "vscode")

				expect(mockCreateTerminal).toHaveBeenCalledWith({
					...windowsShellOptions,
					cwd: "/test/path",
					name: "Alpha",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ALPHA_ACTIVE: "true",
						PROMPT_COMMAND: "sleep 0.05",
						VTE_VERSION: "0",
						PROMPT_EOL_MARK: "",
					},
				})
			} finally {
				// Restore original delay
				Terminal.setCommandDelay(originalDelay)
			}
		})

		it("adds Oh My Zsh integration env var when enabled", () => {
			Terminal.setTerminalZshOhMy(true)
			try {
				TerminalRegistry.createTerminal("/test/path", "vscode")

				expect(mockCreateTerminal).toHaveBeenCalledWith({
					...windowsShellOptions,
					cwd: "/test/path",
					name: "Alpha",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ALPHA_ACTIVE: "true",
						VTE_VERSION: "0",
						PROMPT_EOL_MARK: "",
						ITERM_SHELL_INTEGRATION_INSTALLED: "Yes",
					},
				})
			} finally {
				Terminal.setTerminalZshOhMy(false)
			}
		})

		it("adds Powerlevel10k integration env var when enabled", () => {
			Terminal.setTerminalZshP10k(true)
			try {
				TerminalRegistry.createTerminal("/test/path", "vscode")

				expect(mockCreateTerminal).toHaveBeenCalledWith({
					...windowsShellOptions,
					cwd: "/test/path",
					name: "Alpha",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ALPHA_ACTIVE: "true",
						VTE_VERSION: "0",
						PROMPT_EOL_MARK: "",
						POWERLEVEL9K_TERM_SHELL_INTEGRATION: "true",
					},
				})
			} finally {
				Terminal.setTerminalZshP10k(false)
			}
		})
	})

	it("makes bundled rg available to a new Alpha terminal when it is absent from PATH", async () => {
		const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
		const originalPath = process.env[pathKey]
		const basePath = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin"
		const rgPath = path.join(process.platform === "win32" ? "C:\\alpha-rg" : "/alpha-rg", "rg.exe")
		process.env[pathKey] = basePath
		vi.mocked(resolveRipgrepBinary).mockResolvedValue({
			path: rgPath,
			source: "bundled",
			reason: "using extension-bundled @vscode/ripgrep",
		})

		try {
			await TerminalRegistry.getOrCreateTerminal("/test/rg-path", "rg-path")
			const options = mockCreateTerminal.mock.lastCall?.[0] as vscode.TerminalOptions
			expect(options.env?.[pathKey]).toBe(`${path.dirname(rgPath)}${path.delimiter}${basePath}`)
		} finally {
			if (originalPath === undefined) delete process.env[pathKey]
			else process.env[pathKey] = originalPath
		}
	})

	it("passes the bundled rg path to a new Execa terminal", async () => {
		const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === "PATH") ?? "PATH"
		const originalPath = process.env[pathKey]
		const basePath = process.platform === "win32" ? "C:\\Windows\\System32" : "/usr/bin"
		const rgPath = path.join(process.platform === "win32" ? "C:\\alpha-rg" : "/alpha-rg", "rg.exe")
		process.env[pathKey] = basePath
		vi.mocked(resolveRipgrepBinary).mockResolvedValue({
			path: rgPath,
			source: "bundled",
			reason: "using extension-bundled @vscode/ripgrep",
		})

		try {
			const terminal = await TerminalRegistry.getOrCreateTerminal("/test/rg-execa-path", "rg-execa-path", "execa")
			expect(terminal).toBeInstanceOf(ExecaTerminal)
			expect(terminal.commandEnv?.[pathKey]).toBe(`${path.dirname(rgPath)}${path.delimiter}${basePath}`)
		} finally {
			if (originalPath === undefined) delete process.env[pathKey]
			else process.env[pathKey] = originalPath
		}
	})

	it("does not resolve rg again when it reuses an Alpha terminal", async () => {
		const first = await TerminalRegistry.getOrCreateTerminal("/test/reused-rg-path", "reused-rg-path")
		TerminalRegistry.releaseTerminalReservation(first, "reused-rg-path")
		const second = await TerminalRegistry.getOrCreateTerminal("/test/reused-rg-path", "reused-rg-path")

		expect(second).toBe(first)
		expect(resolveRipgrepBinary).toHaveBeenCalledOnce()
		expect(mockCreateTerminal).toHaveBeenCalledOnce()
	})

	it("claims separate terminals for concurrent commands while rg resolution is pending", async () => {
		let releaseResolution!: (value: undefined) => void
		const resolution = new Promise<undefined>((resolve) => (releaseResolution = resolve))
		vi.mocked(resolveRipgrepBinary).mockReturnValue(resolution)

		const first = TerminalRegistry.getOrCreateTerminal("/test/concurrent-rg-path", "concurrent-rg-path")
		const second = TerminalRegistry.getOrCreateTerminal("/test/concurrent-rg-path", "concurrent-rg-path")
		releaseResolution(undefined)

		expect(await second).not.toBe(await first)
		expect(mockCreateTerminal).toHaveBeenCalledTimes(2)
	})

	it("does not reuse a shell whose output reader settled while the physical command still runs", async () => {
		const first = await TerminalRegistry.getOrCreateTerminal("/test/physical-command", "original")
		first.busy = false
		first.running = true
		const second = await TerminalRegistry.getOrCreateTerminal("/test/physical-command", "other")
		expect(second).not.toBe(first)
		expect(first.taskId).toBe("original")
	})

	it("retains task ownership until a physical command has stopped", async () => {
		const terminal = await TerminalRegistry.getOrCreateTerminal("/test/cleanup-owner", "cleanup-owner")
		terminal.running = true
		TerminalRegistry.releaseTerminalsForTask("cleanup-owner")
		expect(terminal.taskId).toBe("cleanup-owner")

		terminal.running = false
		terminal.busy = false
		TerminalRegistry.releaseTerminalsForTask("cleanup-owner")
		expect(terminal.taskId).toBeUndefined()
	})

	it("retains a busy process whose exit has not been confirmed", async () => {
		const terminal = await TerminalRegistry.getOrCreateTerminal("/test/cleanup-pending", "cleanup-pending")
		terminal.busy = true
		terminal.process = { isSettled: false } as unknown as typeof terminal.process
		TerminalRegistry.releaseTerminalsForTask("cleanup-pending")
		expect(terminal.taskId).toBe("cleanup-pending")

		terminal.process = { isSettled: true } as unknown as typeof terminal.process
		TerminalRegistry.releaseTerminalsForTask("cleanup-pending")
		expect(terminal.taskId).toBeUndefined()
	})

	it("releases an unlaunched reservation without a process", async () => {
		const terminal = await TerminalRegistry.getOrCreateTerminal("/test/cleanup-unlaunched", "cleanup-unlaunched")
		terminal.busy = true
		expect(terminal.process).toBeUndefined()
		TerminalRegistry.releaseTerminalsForTask("cleanup-unlaunched")
		expect(terminal.taskId).toBeUndefined()
		expect(terminal.busy).toBe(false)
	})
	describe("captured interpreter terminal reuse", () => {
		it.each(["execa", "vscode"] as const)(
			"reuses only matching shell/startup identities for %s",
			async (provider) => {
				const shell = {
					shellPath: "/bin/bash",
					family: "bash" as const,
					login: false,
					binaryIdentity: "binary",
					identity: "bash-nonlogin",
				}
				const cwd = `/test/shell-identity-${provider}`
				const first = await TerminalRegistry.getOrCreateTerminal(cwd, "shell-owner", provider, shell)
				TerminalRegistry.releaseTerminalReservation(first, "shell-owner")
				const same = await TerminalRegistry.getOrCreateTerminal(cwd, "shell-owner", provider, shell)
				expect(same).toBe(first)
				TerminalRegistry.releaseTerminalReservation(same, "shell-owner")
				const changed = await TerminalRegistry.getOrCreateTerminal(cwd, "shell-owner", provider, {
					...shell,
					login: true,
					identity: "bash-login",
				})
				expect(changed).not.toBe(first)
				TerminalRegistry.releaseTerminalReservation(changed, "shell-owner")
				const omitted = await TerminalRegistry.getOrCreateTerminal(cwd, "shell-owner", provider)
				expect(omitted).not.toBe(first)
				expect(omitted).not.toBe(changed)
			},
		)

		it("passes explicit executable and startup flags into the stable VS Code adapter", () => {
			const shell = {
				shellPath: "/bin/bash",
				family: "bash" as const,
				login: true,
				binaryIdentity: "binary",
				identity: "bash-login",
			}
			const created = TerminalRegistry.createTerminal("/test/shell-options", "vscode", {}, shell)
			expect(created).toBeInstanceOf(Terminal)
			expect(vscode.window.createTerminal).toHaveBeenLastCalledWith(
				expect.objectContaining({ shellPath: "/bin/bash", shellArgs: ["-l"] }),
			)
		})
	})
})
