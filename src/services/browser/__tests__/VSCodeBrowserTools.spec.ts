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

	it("opens a browser page with browser-only auto-approval and restores the setting", async () => {
		vscodeMock.tools.push({ name: "open_browser_page" })
		vscodeMock.invokeTool.mockResolvedValue({ content: [{ value: "Page ID: page-1" }] })

		await expect(
			invokeVSCodeBrowserTool("open_browser_page", { url: "https://example.com", forceNew: true }),
		).resolves.toBe("Page ID: page-1")

		expect(vscodeMock.executeCommand.mock.calls).toEqual([
			["setContext", "vscode.chat.tools.global.autoApprove.testMode", true],
			["setContext", "vscode.chat.tools.global.autoApprove.testMode", false],
		])
		expect(vscodeMock.configurationUpdate.mock.calls).toEqual([
			["autoApprove", { open_browser_page: true }, 1],
			["autoApprove", undefined, 1],
		])
	})

	it("restores browser-only auto-approval when opening fails", async () => {
		vscodeMock.tools.push({ name: "open_browser_page" })
		vscodeMock.configurationValues.globalValue = { run_playwright_code: false }
		vscodeMock.invokeTool.mockRejectedValue(new Error("open failed"))

		await expect(invokeVSCodeBrowserTool("open_browser_page", { url: "https://example.com" })).rejects.toThrow(
			"open failed",
		)

		expect(vscodeMock.configurationUpdate.mock.calls).toEqual([
			["autoApprove", { run_playwright_code: false, open_browser_page: true }, 1],
			["autoApprove", { run_playwright_code: false }, 1],
		])
		expect(vscodeMock.executeCommand).toHaveBeenLastCalledWith(
			"setContext",
			"vscode.chat.tools.global.autoApprove.testMode",
			false,
		)
	})

	it("does not overwrite an approval setting changed while the browser is opening", async () => {
		vscodeMock.tools.push({ name: "open_browser_page" })
		vscodeMock.invokeTool.mockImplementation(async () => {
			vscodeMock.configurationValues.globalValue = true
			return { content: [{ value: "Page ID: page-1" }] }
		})

		await invokeVSCodeBrowserTool("open_browser_page", { url: "https://example.com" })

		expect(vscodeMock.configurationUpdate).toHaveBeenCalledTimes(1)
		expect(vscodeMock.configurationValues.globalValue).toBe(true)
	})

	it("returns a useful error without invoking VS Code when a browser tool is unavailable", async () => {
		await expect(invokeVSCodeBrowserTool("read_page", { pageId: "missing" })).rejects.toThrow(
			/workbench\.browser\.enableChatTools/,
		)
		expect(vscodeMock.invokeTool).not.toHaveBeenCalled()
	})

	it("forwards an already-aborted request to VS Code as a cancelled token", async () => {
		vscodeMock.tools.push({ name: "read_page" })
		vscodeMock.invokeTool.mockResolvedValue({ content: [{ value: "cancelled" }] })
		const controller = new AbortController()
		controller.abort()

		await invokeVSCodeBrowserTool("read_page", { pageId: "page-1" }, controller.signal)

		expect(vscodeMock.cancellationTokens[0]?.isCancellationRequested).toBe(true)
	})
})
