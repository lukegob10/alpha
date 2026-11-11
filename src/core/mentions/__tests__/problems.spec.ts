import * as path from "path"
import * as vscode from "vscode"

import { parseMentions } from "../index"

vi.mock("vscode", () => ({
	languages: { getDiagnostics: vi.fn() },
	DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
	FileType: { File: 1 },
	workspace: {
		fs: { stat: vi.fn() },
		openTextDocument: vi.fn(),
	},
}))

vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

describe("explicit @problems context", () => {
	const cwd = path.resolve("workspace")
	const uri = {
		fsPath: path.join(cwd, "example.ts"),
		toString: () => "file:///workspace/example.ts",
	} as vscode.Uri
	const diagnostic = (message: string, severity: vscode.DiagnosticSeverity): vscode.Diagnostic => ({
		message,
		severity,
		range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } } as vscode.Range,
	})

	beforeEach(() => {
		vi.clearAllMocks()
		vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([])
		vi.mocked(vscode.workspace.fs.stat).mockResolvedValue({
			type: vscode.FileType.File,
			ctime: 0,
			mtime: 0,
			size: 1,
		})
		vi.mocked(vscode.workspace.openTextDocument).mockResolvedValue({
			lineAt: () => ({ text: "const value = missing" }),
		} as unknown as vscode.TextDocument)
	})

	it("includes explicitly requested diagnostics when automatic inclusion is disabled", async () => {
		vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
			[uri, [diagnostic("Cannot find missing", vscode.DiagnosticSeverity.Error)]],
		])

		const result = await parseMentions("Inspect @problems", cwd, undefined, undefined, false, false)

		expect(result.text).toContain("Cannot find missing")
		expect(result.text).toContain("<workspace_diagnostics>")
		expect(result.text).not.toContain("No errors or warnings detected.")
	})

	it("preserves the configured diagnostic budget for explicit requests", async () => {
		vi.mocked(vscode.languages.getDiagnostics).mockReturnValue([
			[
				uri,
				[
					diagnostic("Warning below the limit", vscode.DiagnosticSeverity.Warning),
					diagnostic("Highest-priority error", vscode.DiagnosticSeverity.Error),
				],
			],
		])

		const result = await parseMentions("Inspect @problems", cwd, undefined, undefined, false, false, 1)

		expect(result.text).toContain("Highest-priority error")
		expect(result.text).not.toContain("Warning below the limit")
		expect(result.text).toContain("1 more problems omitted")
	})

	it("reports a clean workspace only when no diagnostics were returned", async () => {
		const result = await parseMentions("Inspect @problems", cwd, undefined, undefined, false, false)

		expect(result.text).toContain("No errors or warnings detected.")
	})
})
