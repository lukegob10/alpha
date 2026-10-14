import * as vscode from "vscode"

const proxy = vi.hoisted(() => ({
	options: [] as unknown[],
	dispatch: vi.fn(),
	fetch: vi.fn(),
	bootstrap: vi.fn(),
}))
vi.mock("global-agent", () => ({ bootstrap: proxy.bootstrap }))
vi.mock("undici", () => ({
	ProxyAgent: class {
		constructor(options: unknown) {
			proxy.options.push(options)
		}
	},
	setGlobalDispatcher: proxy.dispatch,
	fetch: proxy.fetch,
}))
vi.mock("vscode", () => ({
	ExtensionMode: { Production: 1, Development: 2 },
	workspace: {
		getConfiguration: () => ({
			get: (key: string) =>
				key === "debugProxy.serverUrl" ? "https://localhost:8888" : key.startsWith("debugProxy."),
		}),
		onDidChangeConfiguration: vi.fn(() => ({ dispose: vi.fn() })),
	},
}))

describe("debug proxy TLS policy", () => {
	let context: vscode.ExtensionContext
	let originalFetch: typeof fetch

	beforeEach(() => {
		vi.resetModules()
		vi.clearAllMocks()
		proxy.options = []
		originalFetch = globalThis.fetch
		for (const key of ["GLOBAL_AGENT_HTTP_PROXY", "GLOBAL_AGENT_HTTPS_PROXY", "GLOBAL_AGENT_NO_PROXY"])
			vi.stubEnv(key, undefined)
		vi.stubEnv("NODE_TLS_REJECT_UNAUTHORIZED", "1")
		context = {
			extensionMode: vscode.ExtensionMode.Development,
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
	})
	afterEach(() => {
		for (const subscription of context.subscriptions) subscription.dispose()
		vi.unstubAllEnvs()
		globalThis.fetch = originalFetch
	})

	it("passes no TLS bypass to Undici even for a legacy insecure HTTPS proxy setting", async () => {
		const { initializeNetworkProxy } = await import("../networkProxy")
		await initializeNetworkProxy(context, { appendLine: vi.fn() } as unknown as vscode.OutputChannel)
		expect(proxy.options).toEqual([{ uri: "https://localhost:8888" }])
		expect(proxy.dispatch).toHaveBeenCalledTimes(1)
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
		expect(globalThis.fetch).toBe(proxy.fetch)
		for (const subscription of context.subscriptions) subscription.dispose()
		expect(globalThis.fetch).toBe(originalFetch)
	})

	it("leaves production network configuration alone", async () => {
		context = {
			extensionMode: vscode.ExtensionMode.Production,
			subscriptions: [],
		} as unknown as vscode.ExtensionContext
		const { initializeNetworkProxy } = await import("../networkProxy")
		await initializeNetworkProxy(context)
		expect(proxy.options).toEqual([])
		expect(proxy.bootstrap).not.toHaveBeenCalled()
		expect(process.env.GLOBAL_AGENT_HTTP_PROXY).toBeUndefined()
		expect(process.env.NODE_TLS_REJECT_UNAUTHORIZED).toBe("1")
		expect(globalThis.fetch).toBe(originalFetch)
	})
})
