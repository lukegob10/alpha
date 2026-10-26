import * as path from "path"

import {
	ListResourcesResultSchema,
	ListResourceTemplatesResultSchema,
	ListToolsResultSchema,
	ResourceListChangedNotificationSchema,
	ToolListChangedNotificationSchema,
	type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js"

import type { AlphaProvider } from "../../../core/webview/AlphaProvider"
import { GlobalFileNames } from "../../../shared/globalFileNames"
import { McpHub, ServerConfigSchema, type ConnectedMcpConnection } from "../McpHub"
import { MAX_MCP_PAGINATION_CURSOR_BYTES } from "../pagination"

type CatalogMethod = "tools/list" | "resources/list" | "resources/templates/list"
type CatalogRequest = { method: CatalogMethod; params?: { cursor: string } }
type CatalogResult = {
	tools?: { name: string; inputSchema: { type: "object" } }[]
	resources?: { name: string; uri: string }[]
	resourceTemplates?: { name: string; uriTemplate: string }[]
	nextCursor?: string
}
type RequestOptions = { signal?: AbortSignal; timeout?: number }
type TestConfig = {
	type: "stdio"
	command: string
	args: string[]
	alwaysAllow?: string[]
	disabledTools?: string[]
	timeout?: number
}
type MockClient = ReturnType<typeof createClient>
type MockTransport = {
	start: import("vitest").Mock
	close: import("vitest").Mock
	stderr: { on: import("vitest").Mock }
	onerror?: (error: Error) => void | Promise<void>
	onclose?: () => void | Promise<void>
}

const mocks = vi.hoisted(() => ({
	files: new Map<string, string>(),
	clients: [] as MockClient[],
	transports: [] as MockTransport[],
	transportStarts: [] as import("vitest").Mock[],
	readFile: vi.fn(),
	writeFile: vi.fn(),
	injectVariables: vi.fn(),
	getState: vi.fn(),
	writeQueues: new Map<string, Promise<void>>(),
	writeQueued: vi.fn(),
	beforeWrite: undefined as ((filePath: string, data: unknown) => Promise<void>) | undefined,
}))

vi.mock("fs/promises", () => ({
	readFile: mocks.readFile,
	writeFile: mocks.writeFile,
	access: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("../../../core/webview/AlphaProvider", () => ({ AlphaProvider: class {} }))
vi.mock("../../../utils/fs", () => ({ fileExistsAtPath: vi.fn().mockResolvedValue(true) }))
vi.mock("../../../utils/config", () => ({ injectVariables: mocks.injectVariables }))
vi.mock("../../../utils/safeWriteJson", () => ({
	safeWriteJson: vi.fn(
		async (filePath: string, data: unknown, options?: { prepareData?: () => unknown | Promise<unknown> }) => {
			const key = path.resolve(filePath)
			mocks.writeQueued(key)
			const previous = mocks.writeQueues.get(key) ?? Promise.resolve()
			const writing = previous
				.catch(() => undefined)
				.then(async () => {
					const prepared = options?.prepareData ? await options.prepareData() : data
					await mocks.beforeWrite?.(key, prepared)
					mocks.files.set(key, JSON.stringify(prepared))
				})
			mocks.writeQueues.set(key, writing)
			try {
				await writing
			} finally {
				if (mocks.writeQueues.get(key) === writing) mocks.writeQueues.delete(key)
			}
		},
	),
}))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn().mockImplementation(function () {
		const client = mocks.clients.shift()
		if (!client) throw new Error("No MCP client fixture queued")
		return client
	}),
}))
vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(function () {
		const transport: MockTransport = {
			start: mocks.transportStarts.shift() ?? vi.fn().mockResolvedValue(undefined),
			close: vi.fn().mockResolvedValue(undefined),
			stderr: { on: vi.fn() },
		}
		mocks.transports.push(transport)
		return transport
	}),
	getDefaultEnvironment: vi.fn().mockReturnValue({}),
}))
vi.mock("vscode", () => ({
	workspace: {
		workspaceFolders: [],
		onDidChangeWorkspaceFolders: vi.fn().mockReturnValue({ dispose: vi.fn() }),
	},
	window: {
		showErrorMessage: vi.fn(),
		showInformationMessage: vi.fn(),
		showWarningMessage: vi.fn(),
	},
}))

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void
	let reject!: (reason?: unknown) => void
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise
		reject = rejectPromise
	})
	return { promise, resolve, reject }
}

function catalogPage(method: CatalogMethod, name: string, nextCursor?: string): CatalogResult {
	const cursor = nextCursor === undefined ? {} : { nextCursor }
	switch (method) {
		case "tools/list":
			return { tools: [{ name, inputSchema: { type: "object" } }], ...cursor }
		case "resources/list":
			return { resources: [{ name, uri: `fixture://${name}` }], ...cursor }
		case "resources/templates/list":
			return { resourceTemplates: [{ name, uriTemplate: `fixture://${name}/{id}` }], ...cursor }
	}
}

function createClient(label = "old") {
	const client = {
		onclose: undefined as (() => void | Promise<void>) | undefined,
		onerror: undefined as ((error: Error) => void | Promise<void>) | undefined,
		connect: vi.fn<(transport: unknown, options?: RequestOptions) => Promise<void>>().mockResolvedValue(undefined),
		close: vi.fn().mockResolvedValue(undefined),
		getInstructions: vi.fn().mockReturnValue("fixture instructions"),
		getServerCapabilities: vi
			.fn<() => ServerCapabilities | undefined>()
			.mockReturnValue({ tools: {}, resources: {} }),
		setNotificationHandler: vi.fn<(schema: unknown, handler: () => void | Promise<void>) => void>(),
		request: vi.fn<(request: CatalogRequest, schema?: unknown, options?: RequestOptions) => Promise<CatalogResult>>(
			async ({ method }) => catalogPage(method, label),
		),
	}
	client.connect.mockImplementation(async (transport) => {
		// The SDK owns transport callbacks after Protocol.connect; events flow through client handlers.
		const ownedTransport = transport as MockTransport
		ownedTransport.onclose = () => client.onclose?.()
		ownedTransport.onerror = (error) => client.onerror?.(error)
	})
	return client
}

const config: TestConfig = { type: "stdio", command: "node", args: ["fixture.js"] }
const workspacePath = path.resolve("mcp-pagination-workspace")
const settingsPath = path.resolve("mcp-pagination-settings", GlobalFileNames.mcpSettings)
const projectSettingsPath = path.join(workspacePath, ".alpha", "mcp.json")
const methods: CatalogMethod[] = ["tools/list", "resources/list", "resources/templates/list"]

function writeSettings(source: "global" | "project", serverConfig: TestConfig) {
	mocks.files.set(
		source === "global" ? settingsPath : projectSettingsPath,
		JSON.stringify({
			mcpServers: { shared: serverConfig },
		}),
	)
}

function connectionFor(hub: McpHub, source: "global" | "project" = "global"): ConnectedMcpConnection {
	const connection = hub.connections.find((entry) => entry.server.name === "shared" && entry.server.source === source)
	if (!connection || connection.type !== "connected") throw new Error(`No ${source} fixture connection`)
	return connection
}

function notificationHandler(client: MockClient, schema: unknown) {
	const registration = client.setNotificationHandler.mock.calls.find(([registered]) => registered === schema)
	if (!registration) throw new Error("Expected catalog change notification handler")
	return registration[1]
}

describe("McpHub complete paginated catalogs", () => {
	let hub: McpHub
	let publications: unknown[]

	beforeEach(async () => {
		vi.clearAllMocks()
		mocks.clients.length = 0
		mocks.transports.length = 0
		mocks.transportStarts.length = 0
		mocks.files.clear()
		mocks.writeQueues.clear()
		mocks.beforeWrite = undefined
		mocks.writeQueued.mockReset()
		mocks.injectVariables.mockReset().mockImplementation(async (config: unknown) => config)
		mocks.getState.mockReset().mockResolvedValue({ mcpEnabled: true })
		mocks.files.set(settingsPath, JSON.stringify({ mcpServers: {} }))
		mocks.files.set(projectSettingsPath, JSON.stringify({ mcpServers: {} }))
		mocks.readFile.mockImplementation(async (filePath: string) => {
			const content = mocks.files.get(path.resolve(filePath))
			if (content === undefined) throw new Error(`Unexpected configuration path: ${filePath}`)
			return content
		})
		publications = []
		const provider = {
			cwd: workspacePath,
			ensureSettingsDirectoryExists: vi.fn().mockResolvedValue(path.dirname(settingsPath)),
			ensureMcpServersDirectoryExists: vi.fn().mockResolvedValue(path.dirname(settingsPath)),
			getState: mocks.getState,
			postMessageToWebview: vi.fn(async (message: unknown) => {
				publications.push(structuredClone(message))
			}),
			context: { extension: { packageJSON: { version: "1.0.0" } } },
		}
		hub = new McpHub(provider as unknown as AlphaProvider)
		await hub.waitUntilReady()
		publications.length = 0
	})

	afterEach(async () => {
		await hub.dispose()
		vi.useRealTimers()
	})

	async function connect(client = createClient(), source: "global" | "project" = "global", options = config) {
		writeSettings(source, options)
		mocks.clients.push(client)
		await hub.updateServerConnections({ shared: options }, source)
		return connectionFor(hub, source)
	}

	it("preserves a revoked grant when another settings write was queued before its commit", async () => {
		const client = createClient("allowed")
		await connect(client, "global", { ...config, alwaysAllow: ["allowed"] })
		const writing = deferred<void>()
		const release = deferred<void>()
		const queued = deferred<void>()
		mocks.beforeWrite = async () => {
			writing.resolve()
			await release.promise
		}
		mocks.writeQueued.mockImplementation(() => {
			if (mocks.writeQueued.mock.calls.length === 2) queued.resolve()
		})
		const revoking = hub.toggleToolAlwaysAllow("shared", "global", "allowed", false)
		const revoked = revoking.catch((error: unknown) => error)
		await writing.promise
		const disabling = hub.toggleToolEnabledForPrompt("shared", "global", "other", false)
		const disabled = disabling.catch((error: unknown) => error)
		await queued.promise
		release.resolve()
		expect(await Promise.all([revoked, disabled])).toEqual([undefined, undefined])

		const saved = JSON.parse(mocks.files.get(settingsPath)!)
		expect(saved.mcpServers.shared.alwaysAllow).toEqual([])
		expect(saved.mcpServers.shared.disabledTools).toEqual(["other"])
		expect(connectionFor(hub).server.tools?.[0].alwaysAllow).toBe(false)
	})

	it.each(["global", "project"] as const)("uses a saved %s timeout on the next live tool call", async (source) => {
		const client = createClient()
		await connect(client, source, { ...config, timeout: 60 })
		await hub.updateServerTimeout("shared", 120, source)
		client.request.mockClear()
		await hub.callTool("shared", "old", {}, source)

		expect(client.request.mock.calls[0]?.[0].method).toBe("tools/call")
		expect(client.request.mock.calls[0]?.[2]?.timeout).toBe(120_000)
	})

	it("rejects an invalid timeout before persisting or changing the live configuration", async () => {
		await connect(createClient(), "global", { ...config, timeout: 60 })
		const before = mocks.files.get(settingsPath)
		await expect(hub.updateServerTimeout("shared", 3601, "global")).rejects.toThrow()
		expect(mocks.files.get(settingsPath)).toBe(before)
		expect(JSON.parse(connectionFor(hub).server.config).timeout).toBe(60)
	})

	it.each(["approval", "timeout"])(
		"applies a committed %s update to a replacement live connection",
		async (setting) => {
			const original = await connect(createClient("allowed"), "global", {
				...config,
				alwaysAllow: ["allowed"],
				timeout: 60,
			})
			const writing = deferred<void>()
			const release = deferred<void>()
			mocks.beforeWrite = async () => {
				writing.resolve()
				await release.promise
			}
			const updating =
				setting === "approval"
					? hub.toggleToolAlwaysAllow("shared", "global", "allowed", false)
					: hub.updateServerTimeout("shared", 120, "global")
			const updated = updating.catch((error: unknown) => error)
			await writing.promise
			mocks.clients.push(createClient("allowed"))
			await hub["connectToServer"]("shared", ServerConfigSchema.parse(config), "global")
			const replacement = connectionFor(hub)
			expect(replacement).not.toBe(original)
			release.resolve()

			expect(await updated).toBeUndefined()
			if (setting === "approval") expect(replacement.server.tools?.[0].alwaysAllow).toBe(false)
			else expect(JSON.parse(replacement.server.config).timeout).toBe(120)
		},
	)

	it.each(["removed", "disabled", "replaced"])(
		"does not revive a server %s while a restart is awaiting presentation",
		async (change) => {
			await connect()
			const entering = deferred<void>()
			const release = deferred<void>()
			const presentation = hub as unknown as { notifyWebviewOfServerChanges(): Promise<void> }
			vi.spyOn(presentation, "notifyWebviewOfServerChanges").mockImplementationOnce(async () => {
				entering.resolve()
				await release.promise
			})
			vi.useFakeTimers()
			const restarting = hub.restartConnection("shared", "global")
			await entering.promise
			if (change === "removed") {
				mocks.files.set(settingsPath, JSON.stringify({ mcpServers: {} }))
				await hub.updateServerConnections({}, "global")
			} else if (change === "disabled") {
				await hub.toggleServerDisabled("shared", true, "global")
			} else {
				const replacement = { ...config, args: ["replacement.js"] }
				writeSettings("global", replacement)
				mocks.clients.push(createClient("replacement"))
				await hub.updateServerConnections({ shared: replacement }, "global")
			}
			// A stale restart must never reach another real connection attempt.
			mocks.clients.push(createClient("stale-restart"))
			release.resolve()
			await vi.runAllTimersAsync()
			await restarting
			if (change === "removed") expect(hub.connections).toEqual([])
			else if (change === "disabled") {
				expect(hub.getAllServers()).toEqual([expect.objectContaining({ disabled: true })])
			} else {
				expect(connectionFor(hub).server.tools?.map((tool) => tool.name)).toEqual(["replacement"])
				expect(JSON.parse(connectionFor(hub).server.config).args).toEqual(["replacement.js"])
			}
			expect(mocks.clients).toHaveLength(1)
		},
	)

	it("collects tools, resources, and templates through empty and nonempty cursors with later-page grants", async () => {
		const client = createClient()
		client.request.mockImplementation(async ({ method, params }) => {
			switch (params?.cursor) {
				case undefined:
					return catalogPage(method, "first", "")
				case "":
					return catalogPage(method, "allowed-later", "last")
				case "last":
					return catalogPage(method, "disabled-later")
				default:
					throw new Error("Unexpected cursor")
			}
		})
		const connection = await connect(client, "global", {
			...config,
			alwaysAllow: ["allowed-later"],
			disabledTools: ["disabled-later"],
		})

		expect(connection.server.status).toBe("connected")
		expect(connection.server.tools?.map((tool) => [tool.name, tool.alwaysAllow, tool.enabledForPrompt])).toEqual([
			["first", false, true],
			["allowed-later", true, true],
			["disabled-later", false, false],
		])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual([
			"first",
			"allowed-later",
			"disabled-later",
		])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual([
			"first",
			"allowed-later",
			"disabled-later",
		])
		for (const method of methods) {
			expect(
				client.request.mock.calls.filter(([request]) => request.method === method).map(([request]) => request),
			).toEqual([{ method }, { method, params: { cursor: "" } }, { method, params: { cursor: "last" } }])
		}
	})

	it("keeps same-name global and project catalogs and tool grants tied to their exact source", async () => {
		const globalClient = createClient()
		globalClient.request.mockImplementation(async ({ method, params }) =>
			catalogPage(method, params ? "global-later" : "global-first", params ? undefined : "global-next"),
		)
		const globalConnection = await connect(globalClient, "global", {
			...config,
			alwaysAllow: ["global-later"],
			disabledTools: ["global-first"],
		})
		const projectClient = createClient()
		projectClient.request.mockImplementation(async ({ method, params }) =>
			catalogPage(method, params ? "project-later" : "project-first", params ? undefined : "project-next"),
		)
		const projectConnection = await connect(projectClient, "project", {
			...config,
			alwaysAllow: ["*"],
			disabledTools: ["project-later"],
		})

		expect(
			globalConnection.server.tools?.map((tool) => [tool.name, tool.alwaysAllow, tool.enabledForPrompt]),
		).toEqual([
			["global-first", false, false],
			["global-later", true, true],
		])
		expect(
			projectConnection.server.tools?.map((tool) => [tool.name, tool.alwaysAllow, tool.enabledForPrompt]),
		).toEqual([
			["project-first", true, true],
			["project-later", true, false],
		])
		expect(hub.getServers()).toEqual([projectConnection.server])
		await hub.listResources("shared", "", "global")
		await hub.listResourceTemplates("shared", "", "project")
		expect(globalClient.request.mock.lastCall?.[0]).toEqual({ method: "resources/list", params: { cursor: "" } })
		expect(projectClient.request.mock.lastCall?.[0]).toEqual({
			method: "resources/templates/list",
			params: { cursor: "" },
		})
	})

	it("keeps initial status connecting and publishes all catalogs only after the final page", async () => {
		const client = createClient("new")
		const lastPage = deferred<CatalogResult>()
		const lastPageStarted = deferred<void>()
		client.request.mockImplementation(async ({ method, params }) => {
			if (method === "resources/templates/list") {
				if (!params) return catalogPage(method, "first", "last")
				lastPageStarted.resolve()
				return lastPage.promise
			}
			return catalogPage(method, "new")
		})
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		await lastPageStarted.promise
		const connection = connectionFor(hub)

		expect(connection.server.status).toBe("connecting")
		expect(connection.server.tools).toBeUndefined()
		expect(connection.server.resources).toBeUndefined()
		expect(connection.server.resourceTemplates).toBeUndefined()
		expect(publications).toEqual([])

		lastPage.resolve(catalogPage("resources/templates/list", "last"))
		await connecting
		expect(connection.server.status).toBe("connected")
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["new"])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["new"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["first", "last"])
		expect(publications).toHaveLength(1)
	})

	it.each(methods)(
		"does not present an incomplete initial catalog as connected after %s later-page failure",
		async (failedMethod) => {
			const client = createClient()
			client.request.mockImplementation(async ({ method, params }) => {
				if (method === failedMethod) {
					if (params) throw new Error("later page unavailable")
					return catalogPage(method, "partial", "next")
				}
				return catalogPage(method, "complete")
			})
			const connection = await connect(client)

			expect(connection.server.status).toBe("disconnected")
			expect(connection.server.error).toContain("later page unavailable")
			expect(connection.server.tools).toBeUndefined()
			expect(connection.server.resources).toBeUndefined()
			expect(connection.server.resourceTemplates).toBeUndefined()
			expect(client.close).toHaveBeenCalled()
			expect(mocks.transports[0].close).toHaveBeenCalled()
		},
	)

	it.each(["unreadable", "missing server", "invalid JSON", "malformed grants"])(
		"retains previous tool authority when completed pagination encounters %s configuration",
		async (failure) => {
			const client = createClient()
			client.request.mockImplementation(async ({ method, params }) =>
				catalogPage(method, params ? "disabled-later" : "allowed-first", params ? undefined : "last"),
			)
			const connection = await connect(client, "global", {
				...config,
				alwaysAllow: ["allowed-first"],
				disabledTools: ["disabled-later"],
			})
			const previous = [connection.server.tools, connection.server.resources, connection.server.resourceTemplates]
			switch (failure) {
				case "unreadable":
					mocks.readFile.mockRejectedValue(new Error("tool configuration unavailable"))
					break
				case "missing server":
					mocks.files.set(settingsPath, JSON.stringify({ mcpServers: {} }))
					break
				case "invalid JSON":
					mocks.files.set(settingsPath, '{"mcpServers":')
					break
				case "malformed grants":
					mocks.files.set(
						settingsPath,
						JSON.stringify({
							mcpServers: { shared: { ...config, alwaysAllow: "*", disabledTools: 7 } },
						}),
					)
					break
			}
			client.request.mockClear()

			await expect(hub["refreshServerCatalog"](connection)).rejects.toThrow()
			expect(client.request.mock.calls.map(([request]) => request)).toEqual([
				{ method: "tools/list" },
				{ method: "tools/list", params: { cursor: "last" } },
			])
			expect(connection.server.tools).toBe(previous[0])
			expect(connection.server.resources).toBe(previous[1])
			expect(connection.server.resourceTemplates).toBe(previous[2])
			expect(
				connection.server.tools?.map((tool) => [tool.name, tool.alwaysAllow, tool.enabledForPrompt]),
			).toEqual([
				["allowed-first", true, true],
				["disabled-later", false, false],
			])
		},
	)

	it("retains the previous complete catalog until every refreshed catalog has completed", async () => {
		const client = createClient()
		const connection = await connect(client)
		const previous = {
			tools: connection.server.tools,
			resources: connection.server.resources,
			templates: connection.server.resourceTemplates,
		}
		const lastPage = deferred<CatalogResult>()
		const started = deferred<void>()
		client.request.mockImplementation(async ({ method, params }) => {
			if (method === "resources/templates/list") {
				if (!params) return catalogPage(method, "new-first", "last")
				started.resolve()
				return lastPage.promise
			}
			return catalogPage(method, "new")
		})
		publications.length = 0
		const refreshing = hub.toggleServerDisabled("shared", false, "global")
		await started.promise

		expect(connection.server.tools).toBe(previous.tools)
		expect(connection.server.resources).toBe(previous.resources)
		expect(connection.server.resourceTemplates).toBe(previous.templates)
		expect(publications).toEqual([])

		lastPage.resolve(catalogPage("resources/templates/list", "new-last"))
		await refreshing
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["new"])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["new"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["new-first", "new-last"])
		expect(publications).toHaveLength(1)
	})

	it.each(methods)(
		"retains all old catalogs and reports a %s refresh failure without successful partial publication",
		async (failedMethod) => {
			const client = createClient()
			const connection = await connect(client)
			const previous = [connection.server.tools, connection.server.resources, connection.server.resourceTemplates]
			client.request.mockImplementation(async ({ method, params }) => {
				if (method === failedMethod && params) throw new Error("refresh page failed")
				return catalogPage(method, "partial-new", method === failedMethod ? "last" : undefined)
			})
			publications.length = 0

			await expect(hub.toggleServerDisabled("shared", false, "global")).rejects.toThrow("refresh page failed")
			expect(connection.server.tools).toBe(previous[0])
			expect(connection.server.resources).toBe(previous[1])
			expect(connection.server.resourceTemplates).toBe(previous[2])
			expect(connection.server.error).toContain("refresh page failed")
			expect(publications).toEqual([])
		},
	)

	it.each(["catalog error", "unrelated server error"])(
		"recovers a transient catalog failure while preserving history and handling the current %s",
		async (currentError) => {
			const client = createClient()
			const connection = await connect(client)
			client.request.mockRejectedValueOnce(new Error("transient catalog failure"))
			await expect(hub["refreshServerCatalog"](connection)).rejects.toThrow("transient catalog failure")
			expect(connection.server.error).toBe("transient catalog failure")
			if (currentError === "unrelated server error") {
				const onStderr = mocks.transports[0].stderr.on.mock.calls.find(([event]) => event === "data")?.[1] as
					| ((data: Buffer) => Promise<void>)
					| undefined
				if (!onStderr) throw new Error("Expected stderr handler")
				await onStderr(Buffer.from("unrelated server warning"))
			}
			client.request.mockImplementation(async ({ method }) => catalogPage(method, "recovered"))

			await hub["refreshServerCatalog"](connection)
			expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["recovered"])
			expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["recovered"])
			expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["recovered"])
			expect(connection.server.error).toBe(currentError === "catalog error" ? "" : "unrelated server warning")
			expect(connection.server.errorHistory).toEqual(
				expect.arrayContaining([expect.objectContaining({ message: "transient catalog failure" })]),
			)
		},
	)

	it.each(["approval", "visibility"])(
		"applies a persisted %s revocation to the last complete tools even when the next remote page fails",
		async (authority) => {
			const client = createClient()
			client.request.mockImplementation(async ({ method, params }) =>
				catalogPage(method, params ? "later" : "first", params ? undefined : "last"),
			)
			const connection = await connect(client, "global", {
				...config,
				alwaysAllow: ["first", "later"],
				disabledTools: [],
			})
			const oldResources = connection.server.resources
			const oldTemplates = connection.server.resourceTemplates
			client.request.mockImplementation(async ({ method, params }) => {
				if (params) throw new Error("remote page failed after saved revocation")
				return catalogPage(method, "incomplete-new", "last")
			})

			const updating =
				authority === "approval"
					? hub.toggleToolAlwaysAllow("shared", "global", "first", false)
					: hub.toggleToolEnabledForPrompt("shared", "global", "first", false)
			await expect(updating).rejects.toThrow("remote page failed after saved revocation")
			expect(
				connection.server.tools?.map((tool) => [tool.name, tool.alwaysAllow, tool.enabledForPrompt]),
			).toEqual([
				["first", authority !== "approval", authority !== "visibility"],
				["later", true, true],
			])
			expect(connection.server.resources).toBe(oldResources)
			expect(connection.server.resourceTemplates).toBe(oldTemplates)
			const saved = JSON.parse(mocks.files.get(settingsPath)!)
			if (authority === "approval") {
				expect(saved.mcpServers.shared.alwaysAllow).toEqual(["later"])
			} else {
				expect(saved.mcpServers.shared.disabledTools).toEqual(["first"])
			}
		},
	)

	it("requires full catalog recovery after a resource failure even when triggered by a tool-grant update", async () => {
		const client = createClient()
		const connection = await connect(client)
		client.request.mockImplementation(async ({ method }) => {
			if (method === "resources/list") throw new Error("resource catalog unavailable")
			return catalogPage(method, "old")
		})
		await expect(hub["refreshServerCatalog"](connection)).rejects.toThrow("resource catalog unavailable")
		client.request.mockClear()
		client.request.mockImplementation(async ({ method }) =>
			catalogPage(method, method === "tools/list" ? "old" : "fully-recovered"),
		)

		await hub.toggleToolAlwaysAllow("shared", "global", "old", true)
		expect(client.request.mock.calls.map(([request]) => request.method)).toEqual(methods)
		expect(connection.server.tools?.map((tool) => [tool.name, tool.alwaysAllow])).toEqual([["old", true]])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["fully-recovered"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["fully-recovered"])
		expect(connection.server.error).toBe("")
		expect(connection.server.errorHistory).toEqual(
			expect.arrayContaining([expect.objectContaining({ message: "resource catalog unavailable" })]),
		)
	})

	it("treats explicitly unadvertised catalogs as empty without unsupported requests", async () => {
		const client = createClient()
		client.getServerCapabilities.mockReturnValue({ tools: {} })
		const connection = await connect(client)

		expect(connection.server.status).toBe("connected")
		expect(connection.server.resources).toEqual([])
		expect(connection.server.resourceTemplates).toEqual([])
		expect(client.request.mock.calls.map(([request]) => request.method)).toEqual(["tools/list"])
	})

	it("rejects a repeated cursor without publishing a bounded prefix", async () => {
		const client = createClient()
		client.request.mockImplementation(async ({ method }) => catalogPage(method, "partial", "repeat"))
		const connection = await connect(client)

		expect(connection.server.status).toBe("disconnected")
		expect(connection.server.error).toContain("repeated")
		expect(connection.server.tools).toBeUndefined()
		expect(client.request).toHaveBeenCalledTimes(2)
	})

	it.each([
		["tools/list", "tools", ListToolsResultSchema],
		["resources/list", "resources", ListResourcesResultSchema],
		["resources/templates/list", "resourceTemplates", ListResourceTemplatesResultSchema],
	] as const)(
		"does not publish a catalog after the SDK rejects a malformed %s later page",
		async (failedMethod, field, schema) => {
			const client = createClient()
			client.request.mockImplementation(async ({ method, params }) => {
				if (method === failedMethod) {
					if (params) return schema.parse({ [field]: [{ name: "missing required field" }] })
					return catalogPage(method, "valid-first", "invalid-last")
				}
				return catalogPage(method, "complete")
			})
			const connection = await connect(client)

			expect(connection.server.status).toBe("disconnected")
			const requiredField =
				failedMethod === "tools/list"
					? "inputSchema"
					: failedMethod === "resources/list"
						? "uri"
						: "uriTemplate"
			expect(connection.server.error).toContain(requiredField)
			expect(connection.server.error).toContain("invalid_type")
			expect(connection.server.tools).toBeUndefined()
			expect(connection.server.resources).toBeUndefined()
			expect(connection.server.resourceTemplates).toBeUndefined()
		},
	)

	it("marks timed-out initial discovery as disconnected and aborts the SDK request", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
		const client = createClient()
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementation(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		const signal = await started.promise

		await vi.advanceTimersByTimeAsync(30_000)
		await connecting
		const connection = connectionFor(hub)
		expect(connection.server.status).toBe("disconnected")
		expect(connection.server.error).toContain("timed out")
		expect(connection.server.tools).toBeUndefined()
		expect(signal?.aborted).toBe(true)
		pendingPage.resolve(catalogPage("tools/list", "late", "later"))
		await pendingPage.promise
		expect(client.request).toHaveBeenCalledTimes(1)
	})

	it.each(["success", "error"])(
		"bounds a stalled final-page grant read by the original catalog deadline and ignores late %s",
		async (lateResult) => {
			const client = createClient()
			const connection = await connect(client)
			const previous = [connection.server.tools, connection.server.resources, connection.server.resourceTemplates]
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] })
			const pendingConfig = deferred<string>()
			const configStarted = deferred<void>()
			mocks.readFile.mockImplementationOnce(async () => {
				configStarted.resolve()
				return pendingConfig.promise
			})
			client.request.mockClear()
			client.request.mockImplementation(async ({ method, params }) => {
				if (!params) {
					await new Promise<void>((resolve) => setTimeout(resolve, 10_000))
					return catalogPage(method, "new-first", "last")
				}
				return catalogPage(method, "new-last")
			})
			const refreshing = hub["refreshServerCatalog"](connection)
			const rejected = expect(refreshing).rejects.toThrow("timed out")
			await vi.advanceTimersByTimeAsync(10_000)
			await configStarted.promise
			const signal = client.request.mock.lastCall?.[2]?.signal
			expect(client.request.mock.calls.map(([request]) => request)).toEqual([
				{ method: "tools/list" },
				{ method: "tools/list", params: { cursor: "last" } },
			])
			await vi.advanceTimersByTimeAsync(19_999)
			expect(signal?.aborted).toBe(false)
			expect(connection.server.tools).toBe(previous[0])
			await vi.advanceTimersByTimeAsync(1)
			await rejected
			expect(signal?.aborted).toBe(true)
			expect(connection.server.tools).toBe(previous[0])
			expect(connection.server.resources).toBe(previous[1])
			expect(connection.server.resourceTemplates).toBe(previous[2])
			const timeoutError = connection.server.error
			if (lateResult === "success") {
				pendingConfig.resolve(
					JSON.stringify({
						mcpServers: { shared: { ...config, alwaysAllow: ["new-first"], disabledTools: [] } },
					}),
				)
			} else {
				pendingConfig.reject(new Error("late tool configuration error"))
			}
			await pendingConfig.promise.catch(() => undefined)
			expect(connection.server.tools).toBe(previous[0])
			expect(connection.server.resources).toBe(previous[1])
			expect(connection.server.resourceTemplates).toBe(previous[2])
			expect(connection.server.error).toBe(timeoutError)
			expect(client.request).toHaveBeenCalledTimes(2)
		},
	)

	it("aborts a deleted connection's pending refresh promptly and ignores its late page", async () => {
		const client = createClient()
		await connect(client)
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockClear()
		client.request.mockImplementation(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		const refreshing = hub.toggleServerDisabled("shared", false, "global")
		const rejected = expect(refreshing).rejects.toThrow()
		const signal = await started.promise

		await hub.deleteConnection("shared", "global")
		await rejected
		expect(signal?.aborted).toBe(true)
		expect(hub.connections).toEqual([])
		pendingPage.resolve(catalogPage("tools/list", "late", "later"))
		await pendingPage.promise
		expect(client.request).toHaveBeenCalledTimes(1)
		expect(hub.connections).toEqual([])
	})

	it("aborts initial catalog discovery on disposal without waiting for the transport's pending page", async () => {
		const client = createClient()
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementation(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		const signal = await started.promise

		await hub.dispose()
		await connecting
		expect(signal?.aborted).toBe(true)
		expect(hub.connections).toEqual([])
		pendingPage.resolve(catalogPage("tools/list", "late", "later"))
		await pendingPage.promise
		expect(client.request).toHaveBeenCalledTimes(1)
		expect(hub.connections).toEqual([])
	})

	it("aborts an initializing client's handshake on disposal before catalog requests start", async () => {
		const client = createClient()
		const handshake = deferred<void>()
		const started = deferred<AbortSignal | undefined>()
		client.connect.mockImplementationOnce(async (_transport, options) => {
			started.resolve(options?.signal)
			return handshake.promise
		})
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		const signal = await started.promise

		await hub.dispose()
		await connecting
		expect(signal?.aborted).toBe(true)
		expect(client.request).not.toHaveBeenCalled()
		expect(client.close).toHaveBeenCalled()
		expect(hub.connections).toEqual([])
		handshake.resolve()
		await handshake.promise
		expect(client.request).not.toHaveBeenCalled()
		expect(hub.connections).toEqual([])
	})

	it("prevents a late enabled-state response from starting a disposed hub's connection", async () => {
		const client = createClient()
		const state = deferred<{ mcpEnabled: boolean }>()
		const started = deferred<void>()
		mocks.getState.mockImplementationOnce(async () => {
			started.resolve()
			return state.promise
		})
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		await started.promise

		await hub.dispose()
		await connecting
		state.resolve({ mcpEnabled: true })
		await state.promise
		expect(client.connect).not.toHaveBeenCalled()
		expect(client.request).not.toHaveBeenCalled()
		expect(mocks.transports).toEqual([])
		expect(hub.connections).toEqual([])
	})

	it("closes the unregistered client when disposal interrupts configuration injection", async () => {
		const client = createClient()
		const injectedConfig = deferred<TestConfig>()
		const started = deferred<void>()
		mocks.injectVariables.mockImplementationOnce(async () => {
			started.resolve()
			return injectedConfig.promise
		})
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		await started.promise

		await hub.dispose()
		await connecting
		expect(client.close).toHaveBeenCalled()
		injectedConfig.resolve(config)
		await injectedConfig.promise
		expect(client.connect).not.toHaveBeenCalled()
		expect(client.request).not.toHaveBeenCalled()
		expect(mocks.transports).toEqual([])
		expect(hub.connections).toEqual([])
	})

	it("closes a process that finishes starting after its unregistered connection attempt was disposed", async () => {
		const client = createClient()
		const pendingStart = deferred<void>()
		const started = deferred<void>()
		const lateProcessClosed = deferred<void>()
		let processRunning = false
		mocks.transportStarts.push(
			vi.fn(async () => {
				started.resolve()
				await pendingStart.promise
				processRunning = true
			}),
		)
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		await started.promise
		const transport = mocks.transports[0]
		transport.close.mockImplementation(async () => {
			if (processRunning) lateProcessClosed.resolve()
			processRunning = false
		})

		await hub.dispose()
		await connecting
		expect(client.connect).not.toHaveBeenCalled()
		pendingStart.resolve()
		await lateProcessClosed.promise
		expect(processRunning).toBe(false)
		expect(client.request).not.toHaveBeenCalled()
		expect(client.close).toHaveBeenCalled()
		expect(hub.connections).toEqual([])
	})

	it("lets a newer same-source attempt win before connection insertion and cleans up the stale startup", async () => {
		const oldClient = createClient("stale")
		const pendingStart = deferred<void>()
		const started = deferred<void>()
		const lateProcessClosed = deferred<void>()
		let oldProcessRunning = false
		mocks.transportStarts.push(
			vi.fn(async () => {
				started.resolve()
				await pendingStart.promise
				oldProcessRunning = true
			}),
		)
		mocks.clients.push(oldClient)
		writeSettings("global", config)
		const oldConnecting = hub.updateServerConnections({ shared: config })
		await started.promise
		const oldTransport = mocks.transports[0]
		oldTransport.close.mockImplementation(async () => {
			if (oldProcessRunning) lateProcessClosed.resolve()
			oldProcessRunning = false
		})
		const replacement = await connect(createClient("newer"), "global", {
			...config,
			args: ["newer.js"],
		})
		await oldConnecting

		expect(hub.connections).toHaveLength(1)
		expect(oldClient.connect).not.toHaveBeenCalled()
		expect(oldClient.close).toHaveBeenCalled()
		expect(replacement.server.status).toBe("connected")
		expect(replacement.server.tools?.map((tool) => tool.name)).toEqual(["newer"])
		pendingStart.resolve()
		await lateProcessClosed.promise
		expect(oldProcessRunning).toBe(false)
		expect(connectionFor(hub)).toBe(replacement)
		expect(replacement.server.error).toBe("")
		expect(replacement.server.resources?.map((resource) => resource.name)).toEqual(["newer"])
	})

	it("keeps a replacement connection healthy when an old refresh or old transport events settle later", async () => {
		const client = createClient()
		await connect(client)
		const oldTransport = mocks.transports[0]
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementation(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		const refreshing = hub.toggleServerDisabled("shared", false, "global")
		const rejected = expect(refreshing).rejects.toThrow()
		const signal = await started.promise
		const replacement = await connect(createClient("replacement"), "global", {
			...config,
			args: ["replacement.js"],
		})
		await rejected
		expect(signal?.aborted).toBe(true)

		pendingPage.resolve(catalogPage("tools/list", "stale", "later"))
		await pendingPage.promise
		await oldTransport.onerror?.(new Error("stale transport failure"))
		await oldTransport.onclose?.()
		expect(connectionFor(hub)).toBe(replacement)
		expect(replacement.server.status).toBe("connected")
		expect(replacement.server.error).toBe("")
		expect(replacement.server.tools?.map((tool) => tool.name)).toEqual(["replacement"])
		expect(replacement.server.resources?.map((resource) => resource.name)).toEqual(["replacement"])
		expect(replacement.server.resourceTemplates?.map((template) => template.name)).toEqual(["replacement"])
	})

	it("cancels active pagination when a real transport error reaches the composed SDK and fatal handlers", async () => {
		const client = createClient()
		const connection = await connect(client)
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementationOnce(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		const refreshing = hub["refreshServerCatalog"](connection)
		const rejected = expect(refreshing).rejects.toThrow()
		const signal = await started.promise

		await mocks.transports[0].onerror?.(new Error("active transport failure"))
		await rejected
		expect(signal?.aborted).toBe(true)
		expect(connection.server.status).toBe("disconnected")
		expect(connection.server.error).toContain("active transport failure")
		pendingPage.resolve(catalogPage("tools/list", "late"))
		await pendingPage.promise
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["old"])
	})

	it("keeps an unrelated pending catalog healthy after a late SDK unknown-response diagnostic", async () => {
		const client = createClient()
		const connection = await connect(client)
		const oldTools = connection.server.tools
		const oldErrorHistory = structuredClone(connection.server.errorHistory)
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementationOnce(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		client.request.mockImplementation(async ({ method }) => catalogPage(method, "healthy"))
		let settled = false
		let failure: unknown
		const finished = hub["refreshServerCatalog"](connection).then(
			() => {
				settled = true
			},
			(error) => {
				settled = true
				failure = error
			},
		)
		const signal = await started.promise
		const diagnostic = new Error("Unknown response ID after a cancelled request")
		await client.onerror?.(diagnostic)

		expect(signal?.aborted).toBe(false)
		expect(settled).toBe(false)
		expect(connection.server.status).toBe("connected")
		expect(connection.server.error).toBe("")
		expect(connection.server.errorHistory).toEqual(oldErrorHistory)
		expect(connection.server.tools).toBe(oldTools)
		pendingPage.resolve(catalogPage("tools/list", "healthy"))
		await finished
		expect(failure).toBeUndefined()
		expect(connection.server.status).toBe("connected")
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["healthy"])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["healthy"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["healthy"])
	})

	it("supersedes a pending refresh on the same connection without allowing stale publication", async () => {
		const client = createClient()
		const connection = await connect(client)
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementationOnce(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		const firstRefresh = hub["refreshServerCatalog"](connection)
		const rejected = expect(firstRefresh).rejects.toThrow()
		const signal = await started.promise
		client.request.mockImplementation(async ({ method }) => catalogPage(method, "latest"))

		await hub["refreshServerCatalog"](connection)
		await rejected
		expect(signal?.aborted).toBe(true)
		pendingPage.resolve(catalogPage("tools/list", "stale"))
		await pendingPage.promise
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["latest"])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["latest"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["latest"])
	})

	it.each([ToolListChangedNotificationSchema, ResourceListChangedNotificationSchema])(
		"lets a catalog-change notification replace pending pagination atomically",
		async (schema) => {
			const client = createClient()
			const connection = await connect(client)
			const pendingPage = deferred<CatalogResult>()
			const started = deferred<AbortSignal | undefined>()
			client.request.mockImplementationOnce(async ({ method }) =>
				catalogPage(method, "stale-first", "stale-last"),
			)
			client.request.mockImplementationOnce(async (_request, _resultSchema, options) => {
				started.resolve(options?.signal)
				return pendingPage.promise
			})
			const refreshing = hub["refreshServerCatalog"](connection)
			const rejected = expect(refreshing).rejects.toThrow()
			const signal = await started.promise
			client.request.mockClear()
			client.request.mockImplementation(async ({ method }) => catalogPage(method, "notification-latest"))
			publications.length = 0

			await notificationHandler(client, schema)()
			await rejected
			expect(signal?.aborted).toBe(true)
			expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["notification-latest"])
			expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["notification-latest"])
			expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual([
				"notification-latest",
			])
			expect(client.request.mock.calls.map(([request]) => request.method)).toEqual(methods)
			expect(publications).toHaveLength(1)
			pendingPage.resolve(catalogPage("tools/list", "stale-last"))
			await pendingPage.promise
			expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["notification-latest"])
			expect(connection.server.status).toBe("connected")
			expect(connection.server.error).toBe("")
		},
	)

	it("coalesces a notification burst during initial pagination and completes with the latest full catalog", async () => {
		const client = createClient()
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementationOnce(async ({ method }) => catalogPage(method, "stale-first", "stale-last"))
		client.request.mockImplementationOnce(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		const signal = await started.promise
		client.request.mockClear()
		client.request.mockImplementation(async ({ method }) => catalogPage(method, "latest-initial"))
		const changed = notificationHandler(client, ToolListChangedNotificationSchema)
		const notifications = Array.from({ length: 40 }, () => changed())

		await Promise.all(notifications)
		await connecting
		const connection = connectionFor(hub)
		expect(signal?.aborted).toBe(true)
		expect(connection.server.status).toBe("connected")
		expect(connection.server.error).toBe("")
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["latest-initial"])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["latest-initial"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["latest-initial"])
		expect(client.request.mock.calls.map(([request]) => request.method)).toEqual(methods)
		pendingPage.resolve(catalogPage("tools/list", "stale-last", "another"))
		await pendingPage.promise
		expect(client.request).toHaveBeenCalledTimes(3)
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["latest-initial"])
	})

	it("retains required full discovery when a tool-grant change supersedes initial resource pagination", async () => {
		const client = createClient("restricted")
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementation(async ({ method, params }, _schema, options) => {
			if (method === "resources/list") {
				if (!params) return catalogPage(method, "old-resource", "old-last")
				started.resolve(options?.signal)
				return pendingPage.promise
			}
			return catalogPage(method, "restricted")
		})
		mocks.clients.push(client)
		writeSettings("global", config)
		const connecting = hub.updateServerConnections({ shared: config })
		const signal = await started.promise
		client.request.mockClear()
		client.request.mockImplementation(async ({ method }) => catalogPage(method, "restricted"))

		await hub.toggleToolAlwaysAllow("shared", "global", "restricted", true)
		await connecting
		const connection = connectionFor(hub)
		expect(signal?.aborted).toBe(true)
		expect(connection.server.status).toBe("connected")
		expect(connection.server.tools?.map((tool) => [tool.name, tool.alwaysAllow])).toEqual([["restricted", true]])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["restricted"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["restricted"])
		expect(client.request.mock.calls.map(([request]) => request.method)).toEqual(methods)
		pendingPage.resolve(catalogPage("resources/list", "stale-resource"))
		await pendingPage.promise
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["restricted"])
	})

	it("preserves a pending resource invalidation when a tool-grant refresh supersedes notification discovery", async () => {
		const client = createClient("restricted")
		const connection = await connect(client)
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementation(async ({ method, params }, _schema, options) => {
			if (method === "resources/list") {
				if (!params) return catalogPage(method, "invalidated-first", "invalidated-last")
				started.resolve(options?.signal)
				return pendingPage.promise
			}
			return catalogPage(method, "restricted")
		})
		const notification = notificationHandler(client, ResourceListChangedNotificationSchema)()
		const signal = await started.promise
		client.request.mockClear()
		client.request.mockImplementation(async ({ method }) =>
			catalogPage(method, method === "tools/list" ? "restricted" : "grant-refreshed-resource"),
		)

		await hub.toggleToolAlwaysAllow("shared", "global", "restricted", true)
		await notification
		expect(signal?.aborted).toBe(true)
		expect(connection.server.tools?.map((tool) => [tool.name, tool.alwaysAllow])).toEqual([["restricted", true]])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["grant-refreshed-resource"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual([
			"grant-refreshed-resource",
		])
		expect(client.request.mock.calls.map(([request]) => request.method)).toEqual(methods)
		pendingPage.resolve(catalogPage("resources/list", "stale-invalidated"))
		await pendingPage.promise
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["grant-refreshed-resource"])
		expect(connection.server.status).toBe("connected")
	})

	it("coalesces invalidations during an owned notification refresh into one follow-up", async () => {
		const client = createClient()
		const connection = await connect(client)
		const previousTools = connection.server.tools
		const pendingPage = deferred<CatalogResult>()
		const started = deferred<AbortSignal | undefined>()
		client.request.mockImplementationOnce(async ({ method }) => catalogPage(method, "invalidated-first", "last"))
		client.request.mockImplementationOnce(async (_request, _schema, options) => {
			started.resolve(options?.signal)
			return pendingPage.promise
		})
		const changed = notificationHandler(client, ResourceListChangedNotificationSchema)
		const firstNotification = changed()
		const signal = await started.promise
		expect(connection.server.tools).toBe(previousTools)
		client.request.mockClear()
		client.request.mockImplementation(async ({ method }) => catalogPage(method, "latest-follow-up"))
		const notifications = Array.from({ length: 40 }, () => changed())

		await Promise.all([firstNotification, ...notifications])
		expect(signal?.aborted).toBe(true)
		expect(client.request.mock.calls.map(([request]) => request.method)).toEqual(methods)
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["latest-follow-up"])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["latest-follow-up"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["latest-follow-up"])
		pendingPage.resolve(catalogPage("tools/list", "invalidated-last"))
		await pendingPage.promise
		expect(client.request).toHaveBeenCalledTimes(3)
	})

	it("waits for queued invalidation when the previous refresh has already fulfilled", async () => {
		const client = createClient()
		const connection = await connect(client)
		client.request.mockImplementation(async ({ method }) => catalogPage(method, "completed-refresh"))
		const refresh = hub["refreshServerCatalog"](connection)
		const finalPage = deferred<CatalogResult>()
		const started = deferred<void>()
		const notification = refresh.then(() => {
			client.request.mockImplementation(async ({ method }) => {
				if (method === "resources/templates/list") {
					started.resolve()
					return finalPage.promise
				}
				return catalogPage(method, "latest-queued")
			})
			return notificationHandler(client, ToolListChangedNotificationSchema)()
		})
		let finished = false
		const waiting = hub["waitForCurrentCatalog"](connection, refresh).then(() => {
			finished = true
		})
		await started.promise

		expect(finished).toBe(false)
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["completed-refresh"])
		finalPage.resolve(catalogPage("resources/templates/list", "latest-queued"))
		await Promise.all([waiting, notification])
		expect(finished).toBe(true)
		expect(connection.server.tools?.map((tool) => tool.name)).toEqual(["latest-queued"])
		expect(connection.server.resources?.map((resource) => resource.name)).toEqual(["latest-queued"])
		expect(connection.server.resourceTemplates?.map((template) => template.name)).toEqual(["latest-queued"])
	})

	describe.each([
		["resources/list", "listResources"],
		["resources/templates/list", "listResourceTemplates"],
	] as const)("explicit one-page %s requests", (method, listMethod) => {
		it.each([undefined, "", "opaque-next"])("preserves cursor %j and returns exactly one page", async (cursor) => {
			const client = createClient()
			const connection = await connect(client)
			const previous = [connection.server.resources, connection.server.resourceTemplates]
			const response = catalogPage(method, "requested", "")
			client.request.mockClear()
			client.request.mockResolvedValue(response)

			expect(await hub[listMethod]("shared", cursor, "global")).toEqual(response)
			expect(client.request).toHaveBeenCalledTimes(1)
			expect(client.request.mock.calls[0][0]).toEqual(
				cursor === undefined ? { method } : { method, params: { cursor } },
			)
			expect(connection.server.resources).toBe(previous[0])
			expect(connection.server.resourceTemplates).toBe(previous[1])
		})

		it("rejects promptly when the caller aborts even if the server ignores its signal", async () => {
			const client = createClient()
			await connect(client)
			const pendingPage = deferred<CatalogResult>()
			client.request.mockClear()
			client.request.mockReturnValue(pendingPage.promise)
			const controller = new AbortController()
			const reason = new Error("user cancelled resource listing")
			const listing = hub[listMethod]("shared", "", "global", controller.signal)
			const rejected = expect(listing).rejects.toBe(reason)
			controller.abort(reason)

			await rejected
			expect(client.request.mock.calls[0][2]?.signal?.aborted).toBe(true)
			pendingPage.resolve(catalogPage(method, "late", "later"))
			await pendingPage.promise
			expect(client.request).toHaveBeenCalledTimes(1)
		})

		it("rejects an already-aborted caller before dispatch", async () => {
			const client = createClient()
			await connect(client)
			client.request.mockClear()
			const controller = new AbortController()
			const reason = new Error("already cancelled")
			controller.abort(reason)

			await expect(hub[listMethod]("shared", "", "global", controller.signal)).rejects.toBe(reason)
			expect(client.request).not.toHaveBeenCalled()
		})

		it("rejects an oversized UTF-8 input cursor before dispatch", async () => {
			const client = createClient()
			await connect(client)
			client.request.mockClear()
			const cursor = "é".repeat(MAX_MCP_PAGINATION_CURSOR_BYTES / 2 + 1)

			await expect(hub[listMethod]("shared", cursor, "global")).rejects.toThrow("cursor")
			expect(client.request).not.toHaveBeenCalled()
		})

		it("cancels an in-flight explicit page when its source-specific connection is deleted", async () => {
			const client = createClient()
			await connect(client)
			const pendingPage = deferred<CatalogResult>()
			client.request.mockClear()
			client.request.mockReturnValue(pendingPage.promise)
			const listing = hub[listMethod]("shared", "", "global")
			const rejected = expect(listing).rejects.toThrow()

			await hub.deleteConnection("shared", "global")
			await rejected
			expect(client.request.mock.calls[0][2]?.signal?.aborted).toBe(true)
			pendingPage.resolve(catalogPage(method, "late"))
			await pendingPage.promise
			expect(hub.connections).toEqual([])
		})
	})
})
