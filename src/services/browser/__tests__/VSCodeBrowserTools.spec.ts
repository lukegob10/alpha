import { beforeEach, describe, expect, it, vi } from "vitest"

const vscodeMock = vi.hoisted(() => ({
	tools: [] as Array<{ name: string }>,
	invokeTool: vi.fn(),
	cancellationTokens: [] as Array<{ isCancellationRequested: boolean }>,
	dispose: vi.fn(),
	getConfiguration: vi.fn(),
	configurationGet: vi.fn(),
	configurationInspect: vi.fn(),
	configurationUpdate: vi.fn(),
	executeCommand: vi.fn(),
	configurationValues: {
		defaultValue: false as unknown,
		globalValue: undefined as unknown,
		workspaceValue: undefined as unknown,
		workspaceFolderValue: undefined as unknown,
	},
}))

vi.mock("vscode", () => {
	class LanguageModelTextPart {
		constructor(readonly value: string) {}
	}

	class LanguageModelDataPart {
		constructor(
			readonly data: Uint8Array,
			readonly mimeType: string,
		) {}
	}

	class CancellationTokenSource {
		readonly token = { isCancellationRequested: false }

		constructor() {
			vscodeMock.cancellationTokens.push(this.token)
		}

		cancel() {
			this.token.isCancellationRequested = true
		}

		dispose() {
			vscodeMock.dispose()
		}
	}

	return {
		lm: {
			tools: vscodeMock.tools,
			invokeTool: vscodeMock.invokeTool,
		},
		workspace: {
			getConfiguration: vscodeMock.getConfiguration,
		},
		commands: {
			executeCommand: vscodeMock.executeCommand,
		},
		ConfigurationTarget: {
			Global: 1,
			Workspace: 2,
			WorkspaceFolder: 3,
		},
		CancellationTokenSource,
		LanguageModelTextPart,
		LanguageModelDataPart,
		LanguageModelToolCallPart: class {},
		LanguageModelToolResultPart: class {},
	}
})

import { getAvailableVSCodeBrowserToolNames, invokeVSCodeBrowserTool } from "../VSCodeBrowserTools"

describe("VSCodeBrowserTools", () => {
	beforeEach(() => {
		vscodeMock.tools.splice(0)
		vscodeMock.invokeTool.mockReset()
		vscodeMock.cancellationTokens.splice(0)
		vscodeMock.dispose.mockReset()
		vscodeMock.configurationValues.defaultValue = false
		vscodeMock.configurationValues.globalValue = undefined
		vscodeMock.configurationValues.workspaceValue = undefined
		vscodeMock.configurationValues.workspaceFolderValue = undefined
		vscodeMock.getConfiguration.mockReset()
		vscodeMock.configurationGet.mockReset()
		vscodeMock.configurationInspect.mockReset()
		vscodeMock.configurationUpdate.mockReset()
		vscodeMock.executeCommand.mockReset()

		vscodeMock.configurationGet.mockImplementation(() => {
			const values = vscodeMock.configurationValues
			return values.workspaceFolderValue ?? values.workspaceValue ?? values.globalValue ?? values.defaultValue
		})
		vscodeMock.configurationInspect.mockImplementation(() => ({ ...vscodeMock.configurationValues }))
		vscodeMock.configurationUpdate.mockImplementation(async (_key, value, target) => {
			if (target === 3) vscodeMock.configurationValues.workspaceFolderValue = value
			else if (target === 2) vscodeMock.configurationValues.workspaceValue = value
			else vscodeMock.configurationValues.globalValue = value
		})
		vscodeMock.getConfiguration.mockReturnValue({
			get: vscodeMock.configurationGet,
			inspect: vscodeMock.configurationInspect,
			update: vscodeMock.configurationUpdate,
		})
		vscodeMock.executeCommand.mockResolvedValue(undefined)
	})

	it("discovers only supported browser tools from the live VS Code catalog", () => {
		vscodeMock.tools.push(
			{ name: "read_page" },
			{ name: "extension_unrelated_tool" },
			{ name: "run_playwright_code" },
		)

		expect(getAvailableVSCodeBrowserToolNames()).toEqual(["read_page", "run_playwright_code"])
	})

	it("invokes the global VS Code tool and converts text and image results", async () => {
		vscodeMock.tools.push({ name: "screenshot_page" })
		vscodeMock.invokeTool.mockResolvedValue({
			content: [{ value: "Screenshot captured" }, { mimeType: "image/png", data: new Uint8Array([1, 2, 3]) }],
		})

		const result = await invokeVSCodeBrowserTool("screenshot_page", { pageId: "page-1" })

		expect(vscodeMock.invokeTool).toHaveBeenCalledWith(
			"screenshot_page",
			{ input: { pageId: "page-1" }, toolInvocationToken: undefined },
			expect.objectContaining({ isCancellationRequested: false }),
		)
		expect(result).toEqual([
			{ type: "text", text: "Screenshot captured" },
			{
				type: "image",
				source: { type: "base64", media_type: "image/png", data: "AQID" },
			},
		])
		expect(vscodeMock.dispose).toHaveBeenCalledOnce()
		expect(vscodeMock.configurationUpdate).not.toHaveBeenCalled()
		expect(vscodeMock.executeCommand).not.toHaveBeenCalled()
	})

	it("opens a browser page through host approval without changing settings or internal context", async () => {
		vscodeMock.tools.push({ name: "open_browser_page" })
		vscodeMock.invokeTool.mockResolvedValue({ content: [{ value: "Page ID: page-1" }] })

		await expect(
			invokeVSCodeBrowserTool("open_browser_page", { url: "https://example.com", forceNew: true }),
		).resolves.toBe("Page ID: page-1")

		expect(vscodeMock.executeCommand).not.toHaveBeenCalled()
		expect(vscodeMock.configurationUpdate).not.toHaveBeenCalled()
	})

	it("leaves approval configuration untouched when opening fails", async () => {
		vscodeMock.tools.push({ name: "open_browser_page" })
		vscodeMock.configurationValues.globalValue = { run_playwright_code: false }
		vscodeMock.invokeTool.mockRejectedValue(new Error("open failed"))

		await expect(invokeVSCodeBrowserTool("open_browser_page", { url: "https://example.com" })).rejects.toThrow(
			"open failed",
		)

		expect(vscodeMock.configurationUpdate).not.toHaveBeenCalled()
		expect(vscodeMock.executeCommand).not.toHaveBeenCalled()
	})

	describe.each(["open", "navigate", "navigate-default"] as const)("%s website URLs", (operation) => {
		const name = operation === "open" ? "open_browser_page" : "navigate_page"
		const invoke = (url: string) =>
			operation === "open"
				? invokeVSCodeBrowserTool("open_browser_page", { url, forceNew: true })
				: invokeVSCodeBrowserTool("navigate_page", {
						pageId: "page-1",
						...(operation === "navigate" ? { type: "url" as const } : {}),
						url,
					})

		beforeEach(() => {
			vscodeMock.tools.push({ name })
			vscodeMock.invokeTool.mockResolvedValue({ content: [{ value: "Website opened" }] })
		})

		it.each([
			"Dockerfile",
			"./Dockerfile",
			"../Dockerfile",
			"/workspace/Dockerfile",
			"C:\\project\\Dockerfile",
			"C:/project/Dockerfile",
			"\\\\server\\share\\Dockerfile",
			"file:///workspace/Dockerfile",
			"file:///C:/project/Dockerfile",
			"FILE:///workspace/index.html",
			"vscode://file/workspace/Dockerfile",
			"vscode-remote://ssh-remote+server/workspace/Dockerfile",
			"data:text/html,<h1>Local page</h1>",
			"javascript:alert(1)",
			"ftp://example.com/Dockerfile",
			"about:blank",
			"//example.com",
			"https:example.com",
			"https:///Dockerfile",
			"https://",
			"https://exa mple.com",
			"",
			"   ",
		])("rejects %j before invoking the host", async (url) => {
			await expect(invoke(url)).rejects.toThrow(/HTTP.*HTTPS.*read_file/)
			expect(vscodeMock.invokeTool).not.toHaveBeenCalled()
			expect(vscodeMock.cancellationTokens).toHaveLength(0)
			expect(vscodeMock.configurationUpdate).not.toHaveBeenCalled()
			expect(vscodeMock.executeCommand).not.toHaveBeenCalled()
		})

		it.each([
			"file:///workspace/.alpha/documents/review.html",
			"C:\\project\\docs\\report.htm",
			"alpha-document://open?uri=file%3A%2F%2F%2Fworkspace%2Freview.html&task=task-1",
		])("directs document target %j to the HTML previewer without opening a browser", async (url) => {
			await expect(invoke(url)).rejects.toThrow(/HTML previewer.*alpha-document:\/\/open/)
			expect(vscodeMock.invokeTool).not.toHaveBeenCalled()
			expect(vscodeMock.cancellationTokens).toHaveLength(0)
			expect(vscodeMock.executeCommand).not.toHaveBeenCalled()
		})

		it.each([
			"https://example.com/docs?q=Dockerfile#build",
			"http://example.com",
			"http://localhost:3000",
			"http://127.0.0.1:5173/preview",
			"http://[::1]:3000/",
			"https://intranet/docs",
			"HTTPS://EXAMPLE.COM/docs",
		])("forwards website URL %j unchanged", async (url) => {
			await expect(invoke(url)).resolves.toBe("Website opened")
			expect(vscodeMock.invokeTool).toHaveBeenCalledExactlyOnceWith(
				name,
				{ input: expect.objectContaining({ url }), toolInvocationToken: undefined },
				expect.objectContaining({ isCancellationRequested: false }),
			)
			expect(vscodeMock.dispose).toHaveBeenCalledOnce()
		})
	})

	it("preserves omitted URLs when requesting access to an already-open website tab", async () => {
		vscodeMock.tools.push({ name: "open_browser_page" })
		vscodeMock.invokeTool.mockResolvedValue({ content: [{ value: "Shared page page-1" }] })

		await expect(invokeVSCodeBrowserTool("open_browser_page", {})).resolves.toBe("Shared page page-1")
		expect(vscodeMock.invokeTool).toHaveBeenCalledWith(
			"open_browser_page",
			{ input: {}, toolInvocationToken: undefined },
			expect.anything(),
		)
	})

	it.each([undefined, "url"] as const)("rejects URL navigation without a URL (type=%j)", async (type) => {
		vscodeMock.tools.push({ name: "navigate_page" })
		vscodeMock.invokeTool.mockResolvedValue({ content: [{ value: "Unexpected navigation" }] })

		await expect(invokeVSCodeBrowserTool("navigate_page", { pageId: "page-1", type })).rejects.toThrow(
			/HTTP.*HTTPS.*read_file/,
		)
		expect(vscodeMock.invokeTool).not.toHaveBeenCalled()
	})

	it.each(["back", "forward", "reload"] as const)("preserves %s navigation without a URL", async (type) => {
		vscodeMock.tools.push({ name: "navigate_page" })
		vscodeMock.invokeTool.mockResolvedValue({ content: [{ value: "Navigated" }] })
		const input = { pageId: "page-1", type }

		await expect(invokeVSCodeBrowserTool("navigate_page", input)).resolves.toBe("Navigated")
		expect(vscodeMock.invokeTool).toHaveBeenCalledWith(
			"navigate_page",
			{ input, toolInvocationToken: undefined },
			expect.anything(),
		)
	})

	it("does not overwrite an approval setting changed while the browser is opening", async () => {
		vscodeMock.tools.push({ name: "open_browser_page" })
		vscodeMock.invokeTool.mockImplementation(async () => {
			vscodeMock.configurationValues.globalValue = true
			return { content: [{ value: "Page ID: page-1" }] }
		})

		await invokeVSCodeBrowserTool("open_browser_page", { url: "https://example.com" })

		expect(vscodeMock.configurationUpdate).not.toHaveBeenCalled()
		expect(vscodeMock.configurationValues.globalValue).toBe(true)
	})

	it("returns a useful error without invoking VS Code when a browser tool is unavailable", async () => {
		await expect(invokeVSCodeBrowserTool("read_page", { pageId: "missing" })).rejects.toThrow(
			/workbench\.browser\.enableChatTools/,
		)
		expect(vscodeMock.invokeTool).not.toHaveBeenCalled()
	})

	it("does not invoke the host for an already-aborted request", async () => {
		vscodeMock.tools.push({ name: "read_page" })
		vscodeMock.invokeTool.mockResolvedValue({ content: [{ value: "cancelled" }] })
		const controller = new AbortController()
		controller.abort()

		await expect(invokeVSCodeBrowserTool("read_page", { pageId: "page-1" }, controller.signal)).rejects.toThrow()
		expect(vscodeMock.invokeTool).not.toHaveBeenCalled()
	})

	it("propagates cancellation and rejects a late successful host result", async () => {
		vscodeMock.tools.push({ name: "open_browser_page" })
		const controller = new AbortController()
		let finish!: (value: { content: Array<{ value: string }> }) => void
		vscodeMock.invokeTool.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve
				}),
		)
		const request = invokeVSCodeBrowserTool("open_browser_page", { url: "https://example.com" }, controller.signal)
		controller.abort()
		expect(vscodeMock.cancellationTokens[0].isCancellationRequested).toBe(true)
		finish({ content: [{ value: "late success" }] })
		await expect(request).rejects.toThrow()
		expect(vscodeMock.dispose).toHaveBeenCalledOnce()
		expect(vscodeMock.configurationUpdate).not.toHaveBeenCalled()
	})
})
