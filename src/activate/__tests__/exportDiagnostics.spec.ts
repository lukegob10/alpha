import { readFileSync } from "node:fs"
import * as vscode from "vscode"
import { AlphaProvider } from "../../core/webview/AlphaProvider"
import { generateErrorDiagnostics } from "../../core/webview/diagnosticsHandler"
import { registerCommands } from "../registerCommands"

vi.mock("../../core/webview/AlphaProvider")
vi.mock("../../core/webview/diagnosticsHandler", () => ({ generateErrorDiagnostics: vi.fn() }))
vi.mock("@alpha-code/telemetry", () => ({ TelemetryService: { instance: {} } }))
vi.mock("vscode", () => ({
	CodeActionKind: { QuickFix: { value: "quickfix" }, RefactorRewrite: { value: "refactor.rewrite" } },
	commands: { registerCommand: vi.fn(() => ({ dispose: vi.fn() })) },
	window: { createTextEditorDecorationType: vi.fn(() => ({ dispose: vi.fn() })), showInformationMessage: vi.fn() },
	workspace: { workspaceFolders: [] },
}))

function command() {
	const context = { subscriptions: [] } as unknown as vscode.ExtensionContext
	const outputChannel = { appendLine: vi.fn() } as unknown as vscode.OutputChannel
	registerCommands({ context, outputChannel, provider: {} as AlphaProvider })
	const registration = vi
		.mocked(vscode.commands.registerCommand)
		.mock.calls.find(([id]) => id === "alpha.exportDiagnostics")
	expect(
		registration,
		"The diagnostic export must be available without an ErrorRow or a working webview",
	).toBeDefined()
	return registration![1]
}

describe("local diagnostic export command", () => {
	beforeEach(() => vi.clearAllMocks())

	it("exports the selected stuck chat through the existing collector without stopping or submitting it", async () => {
		const task = { taskId: "selected-task", abortTask: vi.fn(), start: vi.fn() }
		const runtime = { completion: {}, commands: [], obligations: [], truncated: false }
		const selected = {
			getCurrentTask: vi.fn(() => task),
			getTaskSettlementDiagnostics: vi.fn(async () => runtime),
			contextProxy: { globalStorageUri: { fsPath: "/private/storage" } },
			context: { extension: { id: "AlphaInc.alpha" } },
			log: vi.fn(),
		} as unknown as AlphaProvider
		vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(selected)

		await command()()

		expect(generateErrorDiagnostics).toHaveBeenCalledTimes(1)
		const parameters = vi.mocked(generateErrorDiagnostics).mock.calls[0][0]
		expect(parameters).toMatchObject({ taskId: "selected-task", extension: selected.context.extension })
		await expect(parameters.getRuntimeDiagnostics?.()).resolves.toEqual(runtime)
		expect(selected.getTaskSettlementDiagnostics).toHaveBeenCalledWith(task)
		expect(task.abortTask).not.toHaveBeenCalled()
		expect(task.start).not.toHaveBeenCalled()
	})

	it("does not export an unrelated background chat when the selected view is blank", async () => {
		const selected = { getCurrentTask: vi.fn(() => undefined) } as unknown as AlphaProvider
		vi.mocked(AlphaProvider.getVisibleInstance).mockReturnValue(selected)

		await command()()

		expect(generateErrorDiagnostics).not.toHaveBeenCalled()
		expect(vscode.window.showInformationMessage).toHaveBeenCalledTimes(1)
	})

	it("contributes an English Command Palette action independently of debug settings", () => {
		const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"))
		const labels = JSON.parse(readFileSync(new URL("../../package.nls.json", import.meta.url), "utf8"))
		expect(manifest.contributes.commands).toContainEqual({
			command: "alpha.exportDiagnostics",
			title: "%command.exportDiagnostics.title%",
		})
		expect(labels["command.exportDiagnostics.title"]).toBe("Alpha: Export Chat Diagnostics")
		expect(
			manifest.contributes.menus.commandPalette.find(
				(entry: { command: string }) => entry.command === "alpha.exportDiagnostics",
			)?.when,
		).toBeUndefined()
	})
})
