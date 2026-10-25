import * as os from "node:os"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it } from "vitest"

import { createLocalMcpFixture } from "../../../../apps/vscode-e2e/src/scenarios/localMcpFixture"

describe("host MCP fixture with Alpha's installed SDK", () => {
	it("uses a real stdio peer for pagination, invocation, resource bytes, cancellation and disposal", async () => {
		const fixture = await createLocalMcpFixture(os.tmpdir())
		try {
			for (let generation = 0; generation < 2; generation++) {
				const transport = new StdioClientTransport(fixture.configuration)
				const client = new Client({ name: "alpha-transport-contract", version: "1.0.0" })
				try {
					await client.connect(transport)
					expect((await client.listTools()).tools).toHaveLength(10)
					const resources = await client.listResources()
					expect(resources.nextCursor).toBe("resource-page-2")
					expect((await client.listResources({ cursor: resources.nextCursor })).resources[0].uri).toBe(
						"fixture:///second",
					)
					const templates = await client.listResourceTemplates()
					expect(templates.nextCursor).toBe("template-page-2")
					expect(
						(await client.listResourceTemplates({ cursor: templates.nextCursor })).resourceTemplates[0]
							.uriTemplate,
					).toBe("fixture:///second/{id}")
					expect(await client.readResource({ uri: "fixture:///second" })).toMatchObject({
						contents: [{ text: "LOCAL_MCP_RESOURCE_CONTENT" }],
					})
					expect(
						await client.callTool({ name: "calendar_lookup_00", arguments: { query: "owned" } }),
					).toMatchObject({ content: [{ type: "text", text: "LOCAL_MCP_TOOL_RESULT" }] })
					const cancellation = new AbortController()
					const waiting = client.request(
						{ method: "tools/call", params: { name: "fixture_wait" } },
						CallToolResultSchema,
						{ signal: cancellation.signal },
					)
					const rejected = expect(waiting).rejects.toThrow("Owned cancellation")
					// Stdio preserves message order: this response proves the preceding wait request reached the peer.
					await client.listResources()
					expect((await fixture.readEvents()).filter((event) => event.name === "fixture_wait")).toHaveLength(
						generation + 1,
					)
					cancellation.abort(new Error("Owned cancellation"))
					await rejected
				} finally {
					await client.close()
					expect(transport.pid).toBeNull()
				}
			}
			expect((await fixture.readEvents()).filter((event) => event.method === "started")).toHaveLength(2)
		} finally {
			await fixture.dispose()
		}
	}, 15_000)
})
