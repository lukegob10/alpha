import * as fs from "fs/promises"
import * as vscode from "vscode"

import { editTool } from "../../../core/tools/EditTool"
import { fileExistsAtPath } from "../../../utils/fs"
import { DiffViewProvider } from "../DiffViewProvider"

vi.mock("../../../i18n", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../i18n")>()
	const { default: enTools } = await import("../../../i18n/locales/en/tools.json")
	return {
		...actual,
		t: (key: string, options?: Record<string, unknown>) => {
			const [namespace, translationPath] = key.split(":")
			let value: unknown = namespace === "tools" ? enTools : undefined
			for (const segment of translationPath?.split(".") ?? []) {
				value =
					typeof value === "object" && value !== null
						? (value as Record<string, unknown>)[segment]
						: undefined
			}
			if (typeof value !== "string") return key
			return value.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options?.[name] ?? `{{${name}}}`))
		},
	}
})

const mockCwd = "/mock/cwd"
const targetPath = `${mockCwd}/test.txt`
const previewPath = `${mockCwd}/.alpha-diff-1/test.txt`

const testState = {
	diskExists: true,
	diskContent: "",
	previewFiles: new Map<string, string>(),
	previewDirectory: `${mockCwd}/.alpha-diff-1`,
}

vi.mock("fs/promises", () => {
	const readFile = vi.fn()
	const writeFile = vi.fn()
	const unlink = vi.fn()
	const rmdir = vi.fn()
	const mkdtemp = vi.fn()
	const rm = vi.fn()
	const mkdir = vi.fn()
	const module = { readFile, writeFile, unlink, rmdir, mkdtemp, rm, mkdir }
	return { ...module, default: module }
})

vi.mock("path", async () => {
	const actual = await vi.importActual<typeof import("path")>("path")
	return {
		...actual,
		resolve: vi.fn((cwd: string, relPath: string) => `${cwd}/${relPath}`),
		join: vi.fn((...parts: string[]) => parts.join("/")),
		basename: vi.fn((filePath: string) => filePath.split("/").pop()),
	}
})

vi.mock("../../../utils/fs", () => ({
	createDirectoriesForFile: vi.fn().mockResolvedValue([]),
	fileExistsAtPath: vi.fn().mockResolvedValue(true),
}))

vi.mock("delay", () => ({
	default: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("../DecorationController", () => ({
	DecorationController: vi.fn().mockImplementation(() => ({
		setActiveLine: vi.fn(),
		updateOverlayAfterLine: vi.fn(),
		addLines: vi.fn(),
		clear: vi.fn(),
	})),
}))

vi.mock("vscode", () => {
	class MockWorkspaceEdit {
		operations: Array<{ type: "replace" | "delete"; text?: string }> = []

		replace(_uri: unknown, _range: unknown, text: string) {
			this.operations.push({ type: "replace", text })
		}

		delete(_uri: unknown, _range: unknown) {
			this.operations.push({ type: "delete" })
		}
	}

	class MockPosition {
		constructor(
			readonly line: number,
			readonly character: number,
		) {}
	}

	class MockRange {
		constructor(
			readonly start: MockPosition,
			readonly end: MockPosition,
		) {}
	}

	class MockSelection extends MockRange {
		readonly anchor: MockPosition
		readonly active: MockPosition

		constructor(start: MockPosition, end: MockPosition) {
			super(start, end)
			this.anchor = start
			this.active = end
		}
	}

	const uri = (fsPath: string, scheme = "file") => ({ fsPath, path: fsPath, scheme })

	return {
		workspace: {
			textDocuments: [],
			applyEdit: vi.fn().mockResolvedValue(true),
			onDidOpenTextDocument: vi.fn(() => ({ dispose: vi.fn() })),
			openTextDocument: vi.fn(),
			fs: {
				readFile: vi.fn(),
				writeFile: vi.fn(),
				delete: vi.fn(),
				stat: vi.fn(),
			},
		},
		window: {
			showTextDocument: vi.fn().mockResolvedValue({}),
			onDidChangeVisibleTextEditors: vi.fn(() => ({ dispose: vi.fn() })),
			visibleTextEditors: [],
			tabGroups: {
				all: [],
				close: vi.fn().mockResolvedValue(true),
			},
		},
		commands: {
			executeCommand: vi.fn(),
		},
		languages: {
			getDiagnostics: vi.fn(() => []),
		},
		DiagnosticSeverity: {
			Error: 0,
			Warning: 1,
			Information: 2,
			Hint: 3,
		},
		WorkspaceEdit: MockWorkspaceEdit,
		ViewColumn: {
			Active: 1,
			Beside: 2,
		},
		Range: MockRange,
		Position: MockPosition,
		Selection: MockSelection,
		TextEditorRevealType: {
			InCenter: 2,
		},
		TabInputText: class TabInputText {},
		TabInputTextDiff: class TabInputTextDiff {},
		Uri: {
			file: vi.fn((filePath: string) => uri(filePath)),
			parse: vi.fn((value: string) => ({ ...uri(value, value.split(":")[0]), with: vi.fn(() => uri(value)) })),
		},
	}
})

type ControlledDocument = {
	uri: { fsPath: string; scheme: string }
	isDirty: boolean
	lineCount: number
	version: number
	getText: ReturnType<typeof vi.fn>
	positionAt: ReturnType<typeof vi.fn>
	save: ReturnType<typeof vi.fn>
	setText: (nextText: string) => void
}

function createDocument(
	content: string,
	isDirty: boolean,
	savesToDisk: boolean,
	filePath = targetPath,
): ControlledDocument {
	let documentText = content

	const document = {
		uri: { fsPath: filePath, scheme: "file" },
		isDirty,
		lineCount: content.split(/\r\n|\n/).length,
		version: 1,
		getText: vi.fn(() => documentText),
		positionAt: vi.fn((offset: number) => ({ line: 0, character: offset })),
		save: vi.fn(async () => {
			if (savesToDisk) {
				if (document.uri.fsPath === targetPath) {
					testState.diskExists = true
					testState.diskContent = documentText
				} else {
					testState.previewFiles.set(document.uri.fsPath, documentText)
				}
			}
			document.isDirty = false
			return true
		}),
		setText: (nextText: string) => {
			documentText = nextText
			document.lineCount = nextText.split(/\r\n|\n/).length
			document.isDirty = true
			document.version++
		},
	}

	return document
}

async function writeFileToState(filePath: unknown, content: unknown, options?: { flag?: string }): Promise<void> {
	const normalizedPath = canonicalPath(filePath)
	const isTarget = normalizedPath === targetPath
	const fileExists = isTarget ? testState.diskExists : testState.previewFiles.has(normalizedPath)
	if (options?.flag === "wx" && fileExists) {
		throw Object.assign(new Error("already exists"), { code: "EEXIST" })
	}

	if (isTarget) {
		testState.diskExists = true
		testState.diskContent = String(content)
	} else {
		testState.previewFiles.set(normalizedPath, String(content))
	}
}

function configureFileSystem() {
	vi.mocked(fs.readFile).mockImplementation(async (filePath) => {
		const normalizedPath = canonicalPath(filePath)
		if (normalizedPath !== targetPath && testState.previewFiles.has(normalizedPath)) {
			return testState.previewFiles.get(normalizedPath) as any
		}

		if (normalizedPath !== targetPath || !testState.diskExists) {
			throw Object.assign(new Error("missing"), { code: "ENOENT" })
		}

		return testState.diskContent as any
	})
	vi.mocked(fs.writeFile).mockImplementation(writeFileToState as any)
	vi.mocked(fs.unlink).mockImplementation(async (filePath) => {
		const normalizedPath = canonicalPath(filePath)
		if (normalizedPath === targetPath) {
			testState.diskExists = false
		} else {
			testState.previewFiles.delete(normalizedPath)
		}
	})
	vi.mocked(fs.mkdtemp).mockResolvedValue(testState.previewDirectory)
	vi.mocked(fs.rm).mockResolvedValue(undefined)
	vi.mocked(fs.mkdir).mockResolvedValue(undefined)
}

function targetWriteCalls() {
	return vi.mocked(fs.writeFile).mock.calls.filter(([filePath]) => canonicalPath(filePath) === targetPath)
}

function canonicalPath(filePath: unknown): string {
	// Native path imports can prepend the current Windows drive to this virtual fixture root.
	return String(filePath)
		.replaceAll("\\", "/")
		.replace(/^[a-z]:/i, "")
}

function deferred<T>() {
	let resolve!: (value: T) => void
	const promise = new Promise<T>((resolvePromise) => {
		resolve = resolvePromise
	})
	return { promise, resolve }
}

function configurePreviewEdits(previewDocument: ControlledDocument) {
	vi.mocked(vscode.workspace.applyEdit).mockImplementation(async (edit: unknown) => {
		const operations = (edit as { operations: Array<{ type: "replace" | "delete"; text?: string }> }).operations
		const operation = operations.at(-1)
		if (operation?.type === "replace") {
			previewDocument.setText(operation.text ?? "")
		}

		return true
	})
}

function createPreviewEditor(previewDocument: ControlledDocument) {
	return {
		document: previewDocument,
		selection: undefined,
		revealRange: vi.fn(),
		edit: vi.fn(async (callback: (builder: { replace: (range: unknown, text: string) => void }) => void) => {
			let replacement: string | undefined
			callback({
				replace: (_range: unknown, text: string) => {
					replacement = text
				},
			})
			if (replacement !== undefined) {
				previewDocument.setText(replacement)
			}
			return true
		}),
	}
}

function createProvider(options: {
	diskContent: string
	sourceContent: string
	sourceDirty: boolean
	diskExists?: boolean
	includeSource?: boolean
}) {
	testState.diskExists = options.diskExists ?? true
	testState.diskContent = options.diskContent
	configureFileSystem()

	const sourceDocument = createDocument(options.sourceContent, options.sourceDirty, true, targetPath)
	const previewDocument = createDocument(
		options.diskExists === false ? "" : options.diskContent,
		false,
		true,
		previewPath,
	)
	;(vscode.workspace as any).textDocuments =
		options.includeSource === false ? [previewDocument] : [sourceDocument, previewDocument]
	;(vscode.window as any).showTextDocument = vi.fn().mockImplementation(async (uri: { fsPath: string }) => ({
		document: uri.fsPath === targetPath ? sourceDocument : previewDocument,
	}))
	;(vscode.window as any).tabGroups.all = []
	;(vscode.workspace as any).openTextDocument = vi.fn().mockResolvedValue(previewDocument)
	configurePreviewEdits(previewDocument)

	const task = {
		cwd: mockCwd,
		taskKind: "primary",
		consecutiveMistakeCount: 0,
		didEditFile: false,
		didRejectTool: false,
		rooIgnoreController: { validateAccess: vi.fn().mockReturnValue(true) },
		rooProtectedController: { isWriteProtected: vi.fn().mockReturnValue(false) },
		providerRef: {
			deref: vi.fn().mockReturnValue({
				getState: vi.fn().mockResolvedValue({
					diagnosticsEnabled: false,
					includeDiagnosticMessages: true,
					maxDiagnosticMessages: 50,
					experiments: {},
				}),
			}),
		},
		fileContextTracker: { trackFileContext: vi.fn().mockResolvedValue(undefined) },
		say: vi.fn().mockResolvedValue(undefined),
		sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
		recordToolError: vi.fn(),
		recordToolUsage: vi.fn(),
		processQueuedMessages: vi.fn(),
		diffViewProvider: undefined as DiffViewProvider | undefined,
	}
	vi.mocked(fileExistsAtPath).mockResolvedValue(options.diskExists ?? true)
	const provider = new DiffViewProvider(mockCwd, task as any)
	provider.editType = "modify"
	task.diffViewProvider = provider
	const previewEditor = createPreviewEditor(previewDocument)

	// Keep the preview editor independent from the source document. The default
	// diff path must never use the user's dirty source buffer as its modified side.
	vi.spyOn(provider as any, "openDiffEditor").mockImplementation(async () => {
		// The real opener records the preview revision before awaiting the diff
		// command. Mirror that boundary when replacing the UI opener in this test.
		;(provider as any).previewContent = previewDocument.getText()
		;(provider as any).previewVersion = previewDocument.version
		return previewEditor
	})

	return { provider, sourceDocument, previewDocument, previewEditor, task }
}

async function openAndUpdate(provider: DiffViewProvider, content: string): Promise<void> {
	await provider.open("test.txt")
	await provider.update(content, true)
}

describe("DiffViewProvider ownership at the default diff editor boundary", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		;(vscode.workspace as any).textDocuments = []
		testState.diskExists = true
		testState.diskContent = ""
		testState.previewFiles.clear()
	})

	it("does not auto-save or overwrite a pre-existing dirty user buffer", async () => {
		const diskContent = "disk old\n"
		const userBuffer = "user unsaved\n"
		const { provider, sourceDocument, previewDocument } = createProvider({
			diskContent,
			sourceContent: userBuffer,
			sourceDirty: true,
		})

		let opened = false
		try {
			await provider.open("test.txt")
			opened = true
		} catch (error) {
			// A provider may reject the dirty source before opening a preview. If it
			// permits the preview, saveChanges must enforce the same conflict later.
			expect(error).toMatchObject({ message: expect.stringMatching(/unsaved changes|user buffer|conflict/i) })
		}

		if (opened) {
			await provider.update("alpha replacement\n", true)
			await expect(provider.saveChanges(false, 0)).rejects.toThrow(/unsaved changes|user buffer|conflict/i)
		}

		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(sourceDocument.isDirty).toBe(true)
		expect(sourceDocument.getText()).toBe(userBuffer)
		expect(testState.diskContent).toBe(diskContent)
	})

	it("rejects a disk change made while approval is pending", async () => {
		const diskContent = "disk old\n"
		const { provider, sourceDocument, previewDocument } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})

		await openAndUpdate(provider, "alpha replacement\n")
		testState.diskContent = "external edit\n"

		await expect(provider.saveChanges(false, 0)).rejects.toThrow(/changed|conflict|approval/i)
		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(previewDocument.save).not.toHaveBeenCalled()
		expect(testState.diskContent).toBe("external edit\n")
	})

	it("runs the approved default edit path through EditTool without saving the source buffer", async () => {
		const { provider, sourceDocument, task } = createProvider({
			diskContent: "disk old\n",
			sourceContent: "disk old\n",
			sourceDirty: false,
		})
		const askApproval = vi.fn().mockResolvedValue(true)
		const callbacks = {
			askApproval: askApproval,
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}
		task.diffViewProvider = provider

		await editTool.execute(
			{ file_path: "test.txt", old_string: "disk old", new_string: "alpha replacement" },
			task as any,
			callbacks,
		)
		expect(callbacks.handleError).not.toHaveBeenCalled()
		expect(fileExistsAtPath).toHaveBeenCalled()
		expect(fs.readFile).toHaveBeenCalled()
		expect(canonicalPath(vi.mocked(fs.readFile).mock.calls[0]?.[0])).toBe(targetPath)
		expect(callbacks.pushToolResult).toHaveBeenCalled()
		expect(askApproval).toHaveBeenCalledTimes(1)
		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(testState.diskContent).toBe("alpha replacement\n")
		expect(task.didEditFile).toBe(true)
	})

	it("reports an initially dirty source through EditTool without saving or replacing it", async () => {
		const diskContent = "disk old\n"
		const userBuffer = "user unsaved\n"
		const { sourceDocument, task } = createProvider({
			diskContent,
			sourceContent: userBuffer,
			sourceDirty: true,
		})
		const callbacks = {
			askApproval: vi.fn().mockResolvedValue(true),
			handleError: vi.fn(),
			pushToolResult: vi.fn(),
		}

		await editTool.execute(
			{ file_path: "test.txt", old_string: "disk old", new_string: "alpha replacement" },
			task as any,
			callbacks as any,
		)

		expect(callbacks.askApproval).not.toHaveBeenCalled()
		expect(callbacks.handleError).toHaveBeenCalledWith("edit", expect.any(Error))
		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(sourceDocument.isDirty).toBe(true)
		expect(sourceDocument.getText()).toBe(userBuffer)
		expect(testState.diskContent).toBe(diskContent)
		expect(task.didEditFile).toBe(false)
	})

	it("rejects a user buffer change made while approval is pending", async () => {
		const diskContent = "disk old\n"
		const { provider, sourceDocument, previewDocument } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})

		await openAndUpdate(provider, "alpha replacement\n")
		sourceDocument.setText("user edit during approval\n")

		await expect(provider.saveChanges(false, 0)).rejects.toThrow(/unsaved changes|user buffer|conflict/i)
		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(previewDocument.save).not.toHaveBeenCalled()
		expect(sourceDocument.getText()).toBe("user edit during approval\n")
		expect(testState.diskContent).toBe(diskContent)
	})

	it("rejects a source buffer that becomes dirty while the approval baseline is being read", async () => {
		const diskContent = "disk old\n"
		const { provider, sourceDocument } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})
		const readGate = deferred<string>()
		const readStarted = deferred<void>()
		vi.mocked(fs.readFile).mockImplementationOnce(async () => {
			readStarted.resolve(undefined)
			return readGate.promise as any
		})

		const opening = provider.open("test.txt", { exists: true, content: diskContent })
		await readStarted.promise
		sourceDocument.setText("user edit while the baseline was loading\n")
		readGate.resolve(diskContent)

		await expect(opening).rejects.toThrow(/unsaved changes|conflict|approval/i)
		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(sourceDocument.isDirty).toBe(true)
		expect(testState.diskContent).toBe(diskContent)
		expect(targetWriteCalls()).toHaveLength(0)
	})

	it("rejects an expected-missing target that appears during approval", async () => {
		const { provider } = createProvider({
			diskContent: "",
			sourceContent: "",
			sourceDirty: false,
			diskExists: false,
			includeSource: false,
		})
		provider.editType = "create"

		await provider.open("test.txt", { exists: false })
		await provider.update("created by Alpha\n", true)
		testState.diskExists = true
		testState.diskContent = "created by another user\n"

		await expect(provider.saveChanges(false, 0)).rejects.toThrow(/created|conflict|approval/i)
		expect(targetWriteCalls()).toHaveLength(0)
		expect(testState.diskContent).toBe("created by another user\n")
	})

	it("rejects an existing target that disappears during approval", async () => {
		const diskContent = "disk old\n"
		const { provider } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})

		await openAndUpdate(provider, "alpha replacement\n")
		testState.diskExists = false

		await expect(provider.saveChanges(false, 0)).rejects.toThrow(/deleted|conflict|approval/i)
		expect(targetWriteCalls()).toHaveLength(0)
		expect(testState.diskExists).toBe(false)
	})

	it("leaves the source buffer and disk intact when the default diff is denied", async () => {
		const diskContent = "disk old\n"
		const { provider, sourceDocument, previewDocument } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})

		await openAndUpdate(provider, "alpha replacement\n")
		sourceDocument.setText("user edit while approval was pending\n")
		await provider.revertChanges()

		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(sourceDocument.isDirty).toBe(true)
		expect(sourceDocument.getText()).toBe("user edit while approval was pending\n")
		expect(testState.diskContent).toBe(diskContent)
	})

	it("blocks a streaming update after the user amends the preview", async () => {
		const diskContent = "disk old\n"
		const { provider, previewDocument } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})

		await openAndUpdate(provider, "alpha replacement\n")
		previewDocument.setText("user amendment in preview\n")

		await expect(provider.update("alpha second replacement\n", true)).rejects.toThrow(/preview|user changes/i)
		expect(previewDocument.getText()).toBe("user amendment in preview\n")
		expect(targetWriteCalls()).toHaveLength(0)
		expect(testState.diskContent).toBe(diskContent)
	})

	it("commits an approved preview amendment without saving the source document", async () => {
		const diskContent = "disk old\n"
		const { provider, sourceDocument, previewDocument } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})

		await openAndUpdate(provider, "alpha replacement\n")
		previewDocument.setText("user amendment approved\n")
		const result = await provider.saveChanges(false, 0)

		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(targetWriteCalls()).toHaveLength(1)
		expect(testState.diskContent).toBe("user amendment approved\n")
		expect(result.finalContent).toBe("user amendment approved\n")
	})

	it("retains an unapproved preview amendment on denial without saving it", async () => {
		const { provider, previewDocument } = createProvider({
			diskContent: "disk old\n",
			sourceContent: "disk old\n",
			sourceDirty: false,
		})
		await openAndUpdate(provider, "proposal\n")
		previewDocument.setText("user amendment to recover\n")
		await provider.revertChanges()
		expect(previewDocument.save).not.toHaveBeenCalled()
		expect(previewDocument.getText()).toBe("user amendment to recover\n")
		expect(previewDocument.isDirty).toBe(true)
		expect(testState.previewFiles.has(previewPath)).toBe(true)
		expect(testState.diskContent).toBe("disk old\n")
	})

	it.each([false, true])("saves amended preview to a move destination (exists=%s)", async (exists) => {
		const { provider, previewDocument, sourceDocument } = createProvider({
			diskContent: "disk old\n",
			sourceContent: "disk old\n",
			sourceDirty: false,
		})
		const destination = `${mockCwd}/moved.txt`
		if (exists) testState.previewFiles.set(destination, "destination baseline\n")
		await openAndUpdate(provider, "proposal\n")
		previewDocument.setText("approved move amendment\n")
		const result = await provider.saveChanges(false, 0, {
			relPath: "moved.txt",
			expectedFileState: exists ? { exists: true, content: "destination baseline\n" } : { exists: false },
		})
		expect(testState.previewFiles.get(destination)).toBe("approved move amendment\n")
		expect(result.finalContent).toBe("approved move amendment\n")
		expect(result.userEdits).toBeTruthy()
		expect(testState.diskContent).toBe("disk old\n")
		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(targetWriteCalls()).toHaveLength(0)
	})

	it.each(["source", "destination"])("preserves a changed %s before a preview move", async (changed) => {
		const { provider } = createProvider({
			diskContent: "disk old\n",
			sourceContent: "disk old\n",
			sourceDirty: false,
		})
		const destination = `${mockCwd}/moved.txt`
		testState.previewFiles.set(destination, "destination baseline\n")
		await openAndUpdate(provider, "proposal\n")
		if (changed === "source") testState.diskContent = "source changed\n"
		else testState.previewFiles.set(destination, "destination changed\n")
		await expect(
			provider.saveChanges(false, 0, {
				relPath: "moved.txt",
				expectedFileState: { exists: true, content: "destination baseline\n" },
			}),
		).rejects.toThrow("changed")
		expect(testState.diskContent).toBe(changed === "source" ? "source changed\n" : "disk old\n")
		expect(testState.previewFiles.get(destination)).toBe(
			changed === "destination" ? "destination changed\n" : "destination baseline\n",
		)
		expect(vi.mocked(fs.writeFile).mock.calls.some(([file]) => canonicalPath(file) === destination)).toBe(false)
	})

	it("rejects a preview amendment made while the approved save is validating", async () => {
		const diskContent = "disk old\n"
		const { provider, previewDocument } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})

		await openAndUpdate(provider, "alpha replacement\n")
		vi.mocked(fs.readFile).mockImplementationOnce(async () => {
			previewDocument.setText("preview changed during save validation\n")
			return diskContent as any
		})

		await expect(provider.saveChanges(false, 0)).rejects.toThrow(/preview|retry|review|conflict/i)
		expect(targetWriteCalls()).toHaveLength(0)
		expect(testState.diskContent).toBe(diskContent)
		expect(previewDocument.getText()).toBe("preview changed during save validation\n")
	})

	it("does not write the target after reset cancels a save waiting on approval validation", async () => {
		const diskContent = "disk old\n"
		const { provider } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})

		await openAndUpdate(provider, "alpha replacement\n")
		const readGate = deferred<string>()
		const readStarted = deferred<void>()
		vi.mocked(fs.readFile).mockImplementationOnce(async () => {
			readStarted.resolve(undefined)
			return readGate.promise as any
		})
		const saving = provider.saveChanges(false, 0)
		await readStarted.promise

		await provider.reset()
		readGate.resolve(diskContent)

		await expect(saving).rejects.toThrow(/cancel|edit|preview|conflict/i)
		expect(targetWriteCalls()).toHaveLength(0)
		expect(testState.diskContent).toBe(diskContent)
	})

	it("cleans a preview created before reset cancels a delayed preview write", async () => {
		const diskContent = "disk old\n"
		const { provider, sourceDocument } = createProvider({
			diskContent,
			sourceContent: diskContent,
			sourceDirty: false,
		})
		// The preview document does not exist until its temp-file write completes.
		;(vscode.workspace as any).textDocuments = [sourceDocument]
		const writeGate = deferred<void>()
		const writeStarted = deferred<void>()
		vi.mocked(fs.writeFile).mockImplementation(async (filePath, content, options: any) => {
			if (canonicalPath(filePath) === previewPath) {
				writeStarted.resolve(undefined)
				await writeGate.promise
				return writeFileToState(filePath, content, options)
			}
			return writeFileToState(filePath, content, options)
		})

		const opening = provider.open("test.txt", { exists: true, content: diskContent })
		await writeStarted.promise
		const resetting = provider.reset()
		await resetting
		writeGate.resolve(undefined)

		await expect(opening).rejects.toThrow(/cancel|edit|preview/i)
		expect(targetWriteCalls()).toHaveLength(0)
		expect(testState.diskContent).toBe(diskContent)
		expect(testState.previewFiles.has(previewPath)).toBe(false)
		expect(fs.unlink).toHaveBeenCalledWith(previewPath)
	})

	it.each([
		{ label: "empty", content: "" },
		{ label: "literal undefined", content: "undefined" },
		{ label: "literal replacement tokens", content: "$& $$ $1" },
	])("persists $label content through update and approval", async ({ content }) => {
		const { provider, sourceDocument, previewDocument } = createProvider({
			diskContent: "disk old\n",
			sourceContent: "disk old\n",
			sourceDirty: false,
		})

		await openAndUpdate(provider, content)
		const result = await provider.saveChanges(false, 0)

		expect(sourceDocument.save).not.toHaveBeenCalled()
		expect(previewDocument.getText()).toBe(content)
		expect(testState.diskContent).toBe(content)
		expect(result.finalContent).toBe(content)
	})
})
