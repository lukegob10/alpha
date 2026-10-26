import * as fs from "node:fs/promises"
import * as path from "node:path"

export type LocalMcpEvent = {
	method: string
	name?: string
	arguments?: unknown
	pid?: number
}

/** A dependency-free protocol peer, so the extension's production MCP client owns the transport under test. */
const serverSource = String.raw`
const fs = require("node:fs")
const readline = require("node:readline")
const path = require("node:path")
const directory = process.argv[2]
const options = JSON.parse(fs.readFileSync(path.join(directory, "options.json"), "utf8"))
const pending = new Map()
const record = (event) => fs.appendFileSync(path.join(directory, "events.jsonl"), JSON.stringify(event) + "\n")
const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n")
const invalid = (id, message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32602, message } }) + "\n")
const toolNames = [
	...Array.from({ length: 8 }, (_, i) => "calendar_lookup_" + String(i).padStart(2, "0")),
	"fixture_write", "fixture_wait",
]
record({ method: "started", pid: process.pid })
const tool = (name) => ({
	name,
	description: options.description || ("Calendar fixture lookup capability. ".repeat(72)),
	inputSchema: { type: "object", properties: { query: { type: "string" } }, additionalProperties: false },
})
readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const message = JSON.parse(line)
	const { id, method, params = {} } = message
	if (method === "notifications/cancelled") {
		record({ method, arguments: params })
		if (pending.delete(params.requestId)) process.stdout.write(JSON.stringify({
			jsonrpc: "2.0", id: params.requestId, error: { code: -32800, message: "Fixture request cancelled" },
		}) + "\n")
		return
	}
	if (id === undefined) return
	record({ method, name: params.name, arguments: params })
	if (method === "initialize") return reply(id, {
		protocolVersion: params.protocolVersion,
		capabilities: { tools: {}, resources: {} },
		serverInfo: { name: "alpha-local-mcp-fixture", version: "1.0.0" },
	})
	if (method === "ping") return reply(id, {})
	if (method === "tools/list") return reply(id, { tools: toolNames.map(tool) })
	if (method === "resources/list") {
		if (params.cursor !== undefined && params.cursor !== "resource-page-2") return invalid(id, "Unknown resource cursor")
		return reply(id, {
			resources: [{ uri: "fixture:///" + (params.cursor ? "second" : "first"), name: params.cursor ? "second" : "first" }],
			...(params.cursor ? {} : { nextCursor: "resource-page-2" }),
		})
	}
	if (method === "resources/templates/list") {
		if (params.cursor !== undefined && params.cursor !== "template-page-2") return invalid(id, "Unknown template cursor")
		return reply(id, {
			resourceTemplates: [{ uriTemplate: "fixture:///" + (params.cursor ? "second/{id}" : "first/{id}"), name: params.cursor ? "second-template" : "first-template" }],
			...(params.cursor ? {} : { nextCursor: "template-page-2" }),
		})
	}
	if (method === "resources/read") {
		if (typeof params.uri !== "string" || !/^fixture:\/\/\/(?:first|second)(?:\/[^/?#]+)?$/.test(params.uri)) return invalid(id, "Unknown fixture resource")
		return reply(id, {
			contents: [{ uri: params.uri, mimeType: "text/plain", text: "LOCAL_MCP_RESOURCE_CONTENT" }],
		})
	}
	if (method === "tools/call") {
		if (!toolNames.includes(params.name)) return invalid(id, "Unknown fixture tool")
		const args = params.arguments === undefined ? {} : params.arguments
		if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => key !== "query") || (args.query !== undefined && typeof args.query !== "string")) return invalid(id, "Arguments do not match the advertised tool schema")
		if (params.name === "fixture_wait") { pending.set(id, true); return }
		if (params.name === "fixture_write") fs.appendFileSync(path.join(directory, "effect.txt"), "one authorized effect\n")
		return reply(id, { content: [{ type: "text", text: options.toolResultText || "LOCAL_MCP_TOOL_RESULT" }] })
	}
	process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown fixture method" } }) + "\n")
})
`

export async function createLocalMcpFixture(
	root: string,
	options: { description?: string; toolResultText?: string } = {},
) {
	const directory = await fs.mkdtemp(path.join(root, "local-mcp-"))
	const script = path.join(directory, "server.cjs")
	await fs.writeFile(script, serverSource, { flag: "wx" })
	await fs.writeFile(path.join(directory, "options.json"), JSON.stringify(options), { flag: "wx" })
	return {
		directory,
		configuration: {
			type: "stdio" as const,
			command: process.execPath,
			args: [script, directory],
			env: { ELECTRON_RUN_AS_NODE: "1" },
			alwaysAllow: ["calendar_lookup_00", "fixture_wait"],
			timeout: 10,
		},
		async readEvents(): Promise<LocalMcpEvent[]> {
			const text = await fs
				.readFile(path.join(directory, "events.jsonl"), "utf8")
				.catch((error: NodeJS.ErrnoException) => {
					if (error.code === "ENOENT") return ""
					throw error
				})
			return text.trim()
				? text
						.trim()
						.split("\n")
						.map((line) => JSON.parse(line) as LocalMcpEvent)
				: []
		},
		async dispose(): Promise<void> {
			const resolved = await fs.realpath(directory)
			if (
				path.dirname(resolved) !== (await fs.realpath(root)) ||
				!path.basename(resolved).startsWith("local-mcp-")
			)
				throw new Error("Local MCP fixture cleanup escaped its owned directory")
			await fs.rm(resolved, { recursive: true, force: true })
		},
	}
}
