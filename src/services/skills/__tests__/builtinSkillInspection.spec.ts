import * as path from "path"
import type * as vscode from "vscode"

const { registerContentProvider, registerFileSystemProvider, readFile, writeFile, dispose, uriFrom } = vi.hoisted(
	() => ({
		registerContentProvider: vi.fn(),
		registerFileSystemProvider: vi.fn(),
		readFile: vi.fn(),
		writeFile: vi.fn(),
		dispose: vi.fn(),
		uriFrom: vi.fn((components) => ({ authority: "", query: "", fragment: "", ...components })),
	}),
)

vi.mock("vscode", () => ({
	Uri: { from: uriFrom },
	workspace: {
		registerTextDocumentContentProvider: registerContentProvider,
		registerFileSystemProvider,
	},
}))
vi.mock("fs/promises", () => ({ readFile, writeFile }))
vi.mock("ai-sdk-provider-poe/code", () => ({
	POE_DEFAULT_BASE_URL: "https://api.poe.com/v1",
	poeDefaultModelId: "poe-default-model",
	getPoeDefaultModelInfo: vi.fn(() => ({})),
}))

import { builtinSkillInspectionUri, registerBuiltinSkillInspection } from "../builtinSkillInspection"

describe("built-in skill inspection", () => {
	const extensionPath = path.resolve("installed extension")
	let provider: vscode.TextDocumentContentProvider
	const token = {} as vscode.CancellationToken

	beforeEach(() => {
		vi.clearAllMocks()
		registerContentProvider.mockReturnValue({ dispose })
		readFile.mockResolvedValue("# Rich documents\n\nPackaged instructions.")
		registerBuiltinSkillInspection({ fsPath: extensionPath } as vscode.Uri)
		provider = registerContentProvider.mock.calls[0][1]
	})

	it("registers only a read-only virtual document provider with disposable ownership", () => {
		expect(registerContentProvider).toHaveBeenCalledWith("alpha-builtin-skill", {
			provideTextDocumentContent: expect.any(Function),
		})
		expect(registerFileSystemProvider).not.toHaveBeenCalled()
		expect(readFile).not.toHaveBeenCalled()
		const registration = registerBuiltinSkillInspection({ fsPath: extensionPath } as vscode.Uri)
		registration.dispose()
		expect(dispose).toHaveBeenCalledTimes(1)
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("loads the selected skill lazily from the installed extension rather than the workspace", async () => {
		const uri = builtinSkillInspectionUri("rich-documents")
		expect(uriFrom).toHaveBeenCalledWith({ scheme: "alpha-builtin-skill", path: "/rich-documents/SKILL.md" })
		expect(await provider.provideTextDocumentContent(uri, token)).toBe("# Rich documents\n\nPackaged instructions.")
		expect(readFile).toHaveBeenCalledExactlyOnceWith(
			path.join(extensionPath, "assets", "skills", "rich-documents", "SKILL.md"),
			"utf8",
		)
		expect(writeFile).not.toHaveBeenCalled()
	})

	it.each([
		{ path: "/../SKILL.md" },
		{ path: "/rich-documents/../SKILL.md" },
		{ path: "/%2e%2e/SKILL.md" },
		{ path: "/rich-documents%2f..%2fsecret/SKILL.md" },
		{ path: "/rich-documents\\..\\secret/SKILL.md" },
		{ path: "/Rich-Documents/SKILL.md" },
		{ path: "/rich--documents/SKILL.md" },
		{ path: "/rich-documents/reference.md" },
		{ path: "/rich-documents/SKILL.md/extra" },
		{ path: "/rich-documents/SKILL.md", authority: "remote-host" },
		{ path: "/rich-documents/SKILL.md", query: "path=/secret" },
		{ path: "/rich-documents/SKILL.md", fragment: "secret" },
	])("refuses invalid or redirected references before reading: %j", async (components) => {
		const uri = {
			scheme: "alpha-builtin-skill",
			authority: "",
			query: "",
			fragment: "",
			...components,
		} as vscode.Uri
		await expect(provider.provideTextDocumentContent(uri, token)).rejects.toThrow(
			"Invalid built-in skill reference",
		)
		expect(readFile).not.toHaveBeenCalled()
		expect(writeFile).not.toHaveBeenCalled()
	})

	it("preserves missing packaged-resource errors without substituting a user skill", async () => {
		const missing = Object.assign(new Error("Missing packaged skill"), { code: "ENOENT" })
		readFile.mockRejectedValueOnce(missing)
		await expect(
			provider.provideTextDocumentContent(builtinSkillInspectionUri("rich-documents"), token),
		).rejects.toBe(missing)
		expect(readFile).toHaveBeenCalledTimes(1)
		expect(writeFile).not.toHaveBeenCalled()
	})
})
