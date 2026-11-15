import * as vscode from "vscode"

import { ShellIntegrationManager } from "../ShellIntegrationManager"

vi.mock("vscode", () => ({
	env: { appRoot: "/editor" },
	Uri: { file: vi.fn((fsPath: string) => ({ fsPath })) },
	workspace: {
		fs: {
			createDirectory: vi.fn(),
			writeFile: vi.fn(),
		},
	},
}))

async function initializeZsh(env: Record<string, string>): Promise<string> {
	let resolveScript!: (script: string) => void
	const script = new Promise<string>((resolve) => {
		resolveScript = resolve
	})
	vi.mocked(vscode.workspace.fs.createDirectory).mockResolvedValue(undefined)
	vi.mocked(vscode.workspace.fs.writeFile).mockImplementation(async (_uri, content) => {
		resolveScript(Buffer.from(content).toString("utf8"))
	})

	await ShellIntegrationManager.zshInitTmpDir(env)
	return script
}

describe("ShellIntegrationManager Alpha environment", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		vi.spyOn(console, "info").mockImplementation(() => {})
	})

	afterEach(() => {
		vi.unstubAllEnvs()
		vi.restoreAllMocks()
	})

	it("preserves a configured ZDOTDIR through the Alpha shell variable", async () => {
		vi.stubEnv("ZDOTDIR", "/configured/zsh")
		const env: Record<string, string> = {}

		const script = await initializeZsh(env)

		expect(env).toEqual({ ALPHA_ZDOTDIR: "/configured/zsh" })
		expect(script).toContain("ZDOTDIR=${ALPHA_ZDOTDIR:-$HOME}")
		expect(script).toContain("unset ALPHA_ZDOTDIR")
		expect(script).toContain('source "$ZDOTDIR/.zshrc"')
	})

	it("keeps the home-directory fallback when ZDOTDIR is unset", async () => {
		vi.stubEnv("ZDOTDIR", undefined)
		const env: Record<string, string> = {}

		const script = await initializeZsh(env)

		expect(env).toEqual({})
		expect(script).toContain("ZDOTDIR=${ALPHA_ZDOTDIR:-$HOME}")
		expect(script).toContain('[ "$ZDOTDIR" = "$HOME" ] && unset ZDOTDIR')
	})

	it("does not return the startup directory while writing .zshrc", async () => {
		let finishWrite!: () => void
		const writeGate = new Promise<void>((resolve) => (finishWrite = resolve))
		vi.mocked(vscode.workspace.fs.writeFile).mockReturnValue(writeGate)
		const prepared = vi.fn()
		const directory = ShellIntegrationManager.zshInitTmpDir({}).then(prepared)
		await Promise.resolve()
		try {
			expect(vscode.workspace.fs.writeFile).toHaveBeenCalledOnce()
			expect(prepared).not.toHaveBeenCalled()
		} finally {
			finishWrite()
			await directory
		}
		expect(prepared).toHaveBeenCalledWith(expect.stringContaining("alpha-zdotdir-"))
	})
})
