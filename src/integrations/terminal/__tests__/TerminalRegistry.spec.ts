// npx vitest run src/integrations/terminal/__tests__/TerminalRegistry.spec.ts

import * as vscode from "vscode"
import * as path from "node:path"
import { resolveRipgrepBinary } from "../../../services/ripgrep"
import { ExecaTerminal } from "../ExecaTerminal"
import { Terminal } from "../Terminal"
import { TerminalRegistry } from "../TerminalRegistry"

const PAGER = process.platform === "win32" ? "" : "cat"

vi.mock("execa", () => ({
	execa: vi.fn(),
}))
vi.mock("../../../services/ripgrep", () => ({ resolveRipgrepBinary: vi.fn() }))

describe("TerminalRegistry", () => {
	let mockCreateTerminal: any

	beforeEach(() => {
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
		it("creates terminal with PAGER set appropriately for platform", () => {
			TerminalRegistry.createTerminal("/test/path", "vscode")

			expect(mockCreateTerminal).toHaveBeenCalledWith({
				cwd: "/test/path",
				name: "Alpha",
				iconPath: expect.any(Object),
				env: {
					PAGER,
					ROO_ACTIVE: "true",
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
					cwd: "/test/path",
					name: "Alpha",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ROO_ACTIVE: "true",
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
					cwd: "/test/path",
					name: "Alpha",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ROO_ACTIVE: "true",
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
					cwd: "/test/path",
					name: "Alpha",
					iconPath: expect.any(Object),
					env: {
						PAGER,
						ROO_ACTIVE: "true",
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
})
