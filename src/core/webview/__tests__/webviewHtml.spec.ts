import { afterEach, describe, expect, it, vi } from "vitest"
import axios from "axios"
import fs from "node:fs"
import * as vscode from "vscode"
import { resolveWebviewHtml } from "../webviewHtml"

vi.mock("axios", () => ({
	default: { get: vi.fn() },
}))

vi.mock("node:fs", () => ({
	default: {
		existsSync: vi.fn(() => false),
		readFileSync: vi.fn(),
	},
}))

vi.mock("vscode", () => ({
	ExtensionMode: { Production: 1, Development: 2, Test: 3 },
	Uri: {
		joinPath: vi.fn((_base: unknown, ...parts: string[]) => ({ path: parts.join("/") })),
	},
}))

function webview() {
	return {
		cspSource: "vscode-webview://test-csp-source",
		asWebviewUri: vi.fn((uri: { path: string }) => `webview://${uri.path}`),
	} as unknown as vscode.Webview
}

const extensionUri = { fsPath: "/extension" } as vscode.Uri

describe("resolveWebviewHtml", () => {
	afterEach(() => {
		vi.mocked(axios.get).mockReset()
		vi.mocked(fs.existsSync).mockReset()
		vi.mocked(fs.existsSync).mockReturnValue(false)
		vi.mocked(fs.readFileSync).mockReset()
	})

	it("gives built module scripts a nonce and strict-dynamic so extra chunks can load", async () => {
		const html = await resolveWebviewHtml({
			webview: webview(),
			extensionUri,
			extensionMode: vscode.ExtensionMode.Production,
		})
		const scriptSrc = html.match(/script-src[^;]*;/)?.[0]
		expect(scriptSrc).toContain("'strict-dynamic'")
		expect(scriptSrc).toContain("'wasm-unsafe-eval'")
		expect(scriptSrc).toMatch(/'nonce-[A-Za-z0-9]+'/)
		expect(html).toMatch(
			/<script nonce="[A-Za-z0-9]+" type="module" src="webview:\/\/webview-ui\/build\/assets\/index.js"><\/script>/,
		)
		expect(html).not.toContain('data-view="tickets"')
	})

	it("marks the tickets shell so the shared bundle mounts TicketsView", async () => {
		const html = await resolveWebviewHtml({
			webview: webview(),
			extensionUri,
			extensionMode: vscode.ExtensionMode.Production,
			view: "tickets",
		})
		expect(html).toContain('<div id="root" data-view="tickets"></div>')
		expect(html).toContain("'strict-dynamic'")
	})

	it("marks the incidents shell so the shared bundle mounts the incident dashboard", async () => {
		const html = await resolveWebviewHtml({
			webview: webview(),
			extensionUri,
			extensionMode: vscode.ExtensionMode.Production,
			view: "incidents",
		})
		expect(html).toContain('<div id="root" data-view="incidents"></div>')
		expect(html).toContain("'strict-dynamic'")
	})

	it("loads nonce'd Vite module scripts over 127.0.0.1 when the dev server is running", async () => {
		vi.mocked(fs.existsSync).mockReturnValue(true)
		vi.mocked(fs.readFileSync).mockReturnValue("5188\n")
		vi.mocked(axios.get).mockResolvedValue({ status: 200 })
		const html = await resolveWebviewHtml({
			webview: webview(),
			extensionUri,
			extensionMode: vscode.ExtensionMode.Development,
			view: "tickets",
		})
		expect(axios.get).toHaveBeenCalledWith("http://127.0.0.1:5188", {
			timeout: 1_000,
			validateStatus: expect.any(Function),
		})
		expect(html).toContain('<div id="root" data-view="tickets"></div>')
		expect(html).toMatch(
			/<script nonce="[A-Za-z0-9]+" type="module" src="http:\/\/127\.0\.0\.1:5188\/src\/index\.tsx"><\/script>/,
		)
		expect(html).toContain("'strict-dynamic'")
		expect(html).toContain("'wasm-unsafe-eval'")
		expect(html).not.toMatch(/<script type="module" src=/)
	})

	it("falls back to the production shell and reports when Vite is unreachable", async () => {
		vi.mocked(axios.get).mockRejectedValue(new Error("ECONNREFUSED"))
		const onHmrUnavailable = vi.fn()
		const html = await resolveWebviewHtml({
			webview: webview(),
			extensionUri,
			extensionMode: vscode.ExtensionMode.Development,
			onHmrUnavailable,
		})
		expect(onHmrUnavailable).toHaveBeenCalledOnce()
		expect(html).toContain("webview://webview-ui/build/assets/index.js")
		expect(html).toContain("'strict-dynamic'")
	})

	it.each([404, 500, 503])("falls back for both panels when Vite returns HTTP %s", async (status) => {
		vi.mocked(axios.get).mockResolvedValue({ status })
		for (const view of ["app", "tickets", "incidents"] as const) {
			const onHmrUnavailable = vi.fn()
			const html = await resolveWebviewHtml({
				webview: webview(),
				extensionUri,
				extensionMode: vscode.ExtensionMode.Development,
				view,
				onHmrUnavailable,
			})
			expect(onHmrUnavailable).toHaveBeenCalledOnce()
			expect(html).toContain("webview://webview-ui/build/assets/index.js")
			expect(html.includes(`data-view="${view}"`)).toBe(view !== "app")
			expect(html).not.toContain("/@react-refresh")
		}
	})
})
