import type { McpServer, McpTool } from "@alpha-code/types"

const LARGE_TOOL_NAMES = {
	context7: [
		"resolve-library-id",
		"get-library-docs",
		"search-library-docs",
		"list-library-versions",
		"get-library-topics",
		"find-library-symbol",
		"compare-library-releases",
		"summarize-library",
		"search-code-examples",
		"get-library-readme",
		"get-library-changelog",
		"get-library-migration-guide",
		"get-package-metadata",
		"get-api-reference",
		"get-usage-examples",
		"get-dependency-graph",
	],
	github: [
		"search-repositories",
		"get-repository",
		"list-issues",
		"search-issues",
		"get-issue",
		"list-pull-requests",
		"get-pull-request",
		"list-pull-files",
		"get-file-contents",
		"create-issue-draft",
		"compare-commits",
		"list-commits",
		"get-commit",
		"get-workflow-runs",
		"get-workflow-run",
		"search-code",
	],
	postgres: [
		"execute-query",
		"explain-query",
		"list-schemas",
		"list-tables",
		"describe-table",
		"list-columns",
		"sample-rows",
		"search-data-dictionary",
		"get-indexes",
		"get-foreign-keys",
		"get-constraints",
		"list-views",
		"inspect-view",
		"list-functions",
		"get-function-definition",
		"estimate-query-cost",
	],
} as const

const LARGE_SERVER_TOOL_COUNT = Object.values(LARGE_TOOL_NAMES).reduce((total, names) => total + names.length, 0)

export const NOR28_LARGE_MCP_TOOL_COUNT = LARGE_SERVER_TOOL_COUNT
export const NOR28_SMALL_MCP_TOOL_NAMES = ["read-text-file", "write-text-file"] as const

export interface Nor28CatalogFixture {
	readonly noMcpServers: readonly McpServer[]
	readonly smallServers: readonly McpServer[]
	readonly largeServers: readonly McpServer[]
	readonly largeMcpToolCount: number
	readonly smallMcpToolCount: number
	readonly disabledNativeTool: "write_to_file"
	readonly disabledMcpTool: string
	readonly disabledPromptMcpTool: "mcp--context7--disabled-prompt-tool"
	readonly disconnectedServerName: string
	readonly disabledServerName: string
}

function createSmallSchema(operation: string): object {
	return {
		type: "object",
		properties: {
			path: {
				type: "string",
				description: `Workspace-relative path for the ${operation} operation.`,
			},
			encoding: {
				type: "string",
				description: "Text encoding used when reading or writing the file.",
				enum: ["utf-8", "utf-16le", "latin1"],
			},
			content: {
				type: "string",
				description: "File contents. Required for write operations and ignored for reads.",
			},
		},
		required: ["path"],
		additionalProperties: false,
	}
}

function createLargeSchema(serverName: string, toolName: string, index: number): object {
	const operation = `${serverName} ${toolName}`

	return {
		type: "object",
		description: `Structured input for the ${operation} MCP operation. The operation is read-only in this fixture and is designed to resemble a production connector contract with explicit pagination, filtering, field selection, and response shaping. Use only the fields supported by the selected connector and preserve the cursor returned by the previous page when continuing a query. Fixture variant ${String(index + 1).padStart(2, "0")} is deterministic.`,
		properties: {
			query: {
				type: ["string", "null"],
				description:
					"Free-text query or provider-specific predicate. Null means that the operation should use only the structured filters.",
				minLength: 1,
			},
			repository: {
				type: "string",
				description: "Repository, project, or database identifier used to scope the request.",
				pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
			},
			resource_uri: {
				type: ["string", "null"],
				description: "Optional URI or resource key returned by an earlier connector response.",
				format: "uri",
			},
			filters: {
				type: "object",
				description: "Structured filters applied before pagination and result shaping.",
				properties: {
					language: {
						type: "array",
						items: { type: "string", description: "Language or content type name." },
						minItems: 0,
						maxItems: 32,
						uniqueItems: true,
						description: "Optional language, schema, or content type filters.",
					},
					path_prefix: {
						type: "string",
						description: "Optional path or namespace prefix within the selected resource.",
						maxLength: 512,
					},
					include_archived: {
						type: "boolean",
						default: false,
						description: "Whether archived or hidden records should be included.",
					},
					labels: {
						type: "object",
						description: "Provider labels that must match exactly when supplied.",
						additionalProperties: { type: "string" },
					},
				},
				required: ["language"],
				additionalProperties: false,
			},
			selection: {
				type: "object",
				description: "Fields and deterministic ordering requested from the connector.",
				properties: {
					fields: {
						type: "array",
						items: {
							type: "string",
							enum: ["id", "name", "path", "title", "content", "url", "updated_at", "metadata"],
						},
						minItems: 1,
						maxItems: 32,
						uniqueItems: true,
					},
					sort_by: {
						type: "string",
						enum: ["relevance", "name", "path", "updated_at"],
					},
					descending: {
						type: "boolean",
						default: false,
					},
				},
				required: ["fields", "sort_by"],
				additionalProperties: false,
			},
			pagination: {
				type: "object",
				description: "Cursor-based pagination controls. Use the returned next_cursor for subsequent pages.",
				properties: {
					cursor: {
						type: ["string", "null"],
						description: "Opaque continuation cursor from a previous response.",
					},
					page_size: {
						type: "integer",
						minimum: 1,
						maximum: 100,
						default: 25,
					},
					include_total: {
						type: "boolean",
						default: false,
						description: "Whether the connector should calculate an exact result count.",
					},
				},
				required: ["page_size"],
				additionalProperties: false,
			},
			output: {
				type: "object",
				description: "Response formatting and metadata controls for the connector result.",
				properties: {
					format: {
						type: "string",
						enum: ["json", "markdown", "csv"],
					},
					include_metadata: {
						type: "boolean",
						default: true,
					},
					max_results: {
						type: "integer",
						minimum: 1,
						maximum: 1000,
						default: 100,
					},
				},
				required: ["format"],
				additionalProperties: false,
			},
			options: {
				type: "array",
				description: "Connector-specific options retained as explicit name/value pairs.",
				items: {
					type: "object",
					properties: {
						name: { type: "string", minLength: 1 },
						value: { type: ["string", "number", "boolean", "null"] },
						enabled: { type: "boolean", default: true },
					},
					required: ["name"],
					additionalProperties: false,
				},
				maxItems: 16,
			},
		},
		required: ["repository", "selection", "pagination", "output"],
		additionalProperties: false,
	}
}

function createTool(name: string, description: string, inputSchema: object, enabledForPrompt = true): McpTool {
	return {
		name,
		description,
		inputSchema,
		...(enabledForPrompt ? {} : { enabledForPrompt: false }),
	}
}

function createServer(
	name: string,
	tools: McpTool[] | undefined,
	options: Pick<McpServer, "status" | "source" | "disabled"> = { status: "connected", source: "global" },
): McpServer {
	return {
		name,
		config: JSON.stringify({ type: "stdio", command: "nor28-fixture", args: [name] }),
		status: options.status,
		source: options.source,
		...(options.disabled === undefined ? {} : { disabled: options.disabled }),
		...(tools === undefined ? {} : { tools }),
	}
}

function createLargeServers(): McpServer[] {
	const servers = Object.entries(LARGE_TOOL_NAMES).map(([serverName, toolNames]) =>
		createServer(
			serverName,
			toolNames.map((toolName, index) =>
				createTool(
					toolName,
					`Use the ${serverName} connector to ${toolName.replace(/-/g, " ")} with scoped, paginated results and stable identifiers.`,
					createLargeSchema(serverName, toolName, index),
				),
			),
			{
				status: "connected",
				source: serverName === "github" ? "project" : "global",
			},
		),
	)

	// The production hub omits disabled servers before the native MCP catalog is built.
	// Keeping tools on this server makes the connection filter observable in the fixture.
	servers.push(
		createServer(
			"disabled-archive",
			[
				createTool(
					"search-archive",
					"Search an archived connector snapshot.",
					createLargeSchema("archive", "search-archive", 48),
				),
				createTool(
					"get-archive-record",
					"Read an archived connector record.",
					createLargeSchema("archive", "get-archive-record", 49),
				),
			],
			{ status: "connected", source: "global", disabled: true },
		),
	)

	// A disconnected hub entry has no fetched tools, matching McpHub's placeholder connection.
	servers.push(createServer("offline-docs", undefined, { status: "disconnected", source: "global" }))

	// The disabled prompt flag is distinct from the task's disabledTools policy and is
	// filtered by getMcpServerTools itself.
	servers[0].tools?.push(
		createTool(
			"disabled-prompt-tool",
			"A connector tool disabled by the MCP prompt policy.",
			createLargeSchema("context7", "disabled-prompt-tool", 50),
			false,
		),
	)

	return servers
}

function getServersLikeMcpHub(servers: readonly McpServer[]): McpServer[] {
	const enabledConnections = servers.filter((server) => !server.disabled)
	const serversByName = new Map<string, McpServer>()

	for (const server of enabledConnections) {
		const existing = serversByName.get(server.name)
		if (!existing || (server.source === "project" && existing.source !== "project")) {
			serversByName.set(server.name, server)
		}
	}

	return Array.from(serversByName.values())
}

export function createNor28Provider(servers: readonly McpServer[]) {
	const exposedServers = getServersLikeMcpHub(servers)
	const mcpHub = {
		getServers: () => exposedServers,
	}

	return {
		context: {},
		getMcpHub: () => mcpHub,
	}
}

export function createNor28CatalogFixture(): Nor28CatalogFixture {
	const smallServers = [
		createServer(
			"filesystem",
			NOR28_SMALL_MCP_TOOL_NAMES.map((name) =>
				createTool(name, `Read or write a workspace file using ${name}.`, createSmallSchema(name)),
			),
			{ status: "connected", source: "global" },
		),
		createServer(
			"disabled-notes",
			[createTool("search-notes", "Search disabled notes storage.", createSmallSchema("search-notes"))],
			{ status: "connected", source: "global", disabled: true },
		),
		createServer("offline-calendar", undefined, { status: "disconnected", source: "global" }),
	]

	const largeServers = createLargeServers()

	return {
		noMcpServers: [],
		smallServers,
		largeServers,
		largeMcpToolCount: NOR28_LARGE_MCP_TOOL_COUNT,
		smallMcpToolCount: NOR28_SMALL_MCP_TOOL_NAMES.length,
		disabledNativeTool: "write_to_file",
		disabledMcpTool: "mcp--context7--get-library-docs",
		disabledPromptMcpTool: "mcp--context7--disabled-prompt-tool",
		disconnectedServerName: "offline-docs",
		disabledServerName: "disabled-archive",
	}
}

export function getNor28ExposedServers(servers: readonly McpServer[]): readonly McpServer[] {
	return getServersLikeMcpHub(servers)
}
