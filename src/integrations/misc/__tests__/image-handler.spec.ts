import * as vscode from "vscode"
import { openImage } from "../image-handler"

vi.mock("vscode", () => ({
	Uri: { file: vi.fn((fsPath: string) => ({ fsPath })) },
	workspace: { fs: { writeFile: vi.fn(), readFile: vi.fn(async () => Buffer.from("hello")), delete: vi.fn() } },
	commands: { executeCommand: vi.fn() },
	env: { clipboard: { writeText: vi.fn() } },
	window: { showErrorMessage: vi.fn(), showInformationMessage: vi.fn() },
}))
vi.mock("../../../utils/path", () => ({ getWorkspacePath: () => "F:/workspace" }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

describe("openImage", () => {
	beforeEach(() => vi.clearAllMocks())

	it("opens an SVG diagram in the native image preview with its original UTF-8 contents", async () => {
		const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>Revenue £ → résumé</text></svg>'
		await openImage(`data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`)
		expect(vscode.workspace.fs.writeFile).toHaveBeenCalledWith(
			expect.objectContaining({ fsPath: expect.stringMatching(/\.svg$/) }),
			Buffer.from(svg),
		)
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.openWith",
			expect.objectContaining({ fsPath: expect.stringMatching(/\.svg$/) }),
			"imagePreview.previewEditor",
		)
		expect(vscode.window.showErrorMessage).not.toHaveBeenCalled()
	})

	it("preserves the existing PNG opening path", async () => {
		await openImage("data:image/png;base64,aGVsbG8=")
		expect(vscode.commands.executeCommand).toHaveBeenCalledWith(
			"vscode.open",
			expect.objectContaining({ fsPath: expect.stringMatching(/\.png$/) }),
		)
	})

	it("copies data images to the clipboard without creating a temporary file", async () => {
		await openImage("data:image/png;base64,aGVsbG8", { values: { action: "copy" } })

		expect(vscode.env.clipboard.writeText).toHaveBeenCalledWith("data:image/png;base64,aGVsbG8=")
		expect(vscode.window.showInformationMessage).toHaveBeenCalledWith("common:info.image_copied_to_clipboard")
		expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled()
		expect(vscode.workspace.fs.readFile).not.toHaveBeenCalled()
		expect(vscode.workspace.fs.delete).not.toHaveBeenCalled()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
	})

	it("deletes the temporary file when the native preview fails to open", async () => {
		vi.mocked(vscode.commands.executeCommand).mockRejectedValueOnce(new Error("Preview failed"))

		await openImage("data:image/png;base64,aGVsbG8=")

		const [previewUri] = vi.mocked(vscode.workspace.fs.writeFile).mock.calls[0]
		expect(vscode.workspace.fs.delete).toHaveBeenCalledWith(previewUri)
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.error_opening_image")
	})

	it("keeps unsupported SVG data encodings out of the filesystem", async () => {
		await openImage("data:image/svg+xml,<svg></svg>")
		expect(vscode.workspace.fs.writeFile).not.toHaveBeenCalled()
		expect(vscode.commands.executeCommand).not.toHaveBeenCalled()
		expect(vscode.window.showErrorMessage).toHaveBeenCalledWith("common:errors.invalid_data_uri")
	})
})
