import { strict as assert } from "node:assert"
import { spawn } from "node:child_process"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createInterface } from "node:readline"
import { test } from "node:test"

import { createLocalMcpFixture } from "./localMcpFixture"

test("local MCP peer pages catalogs, records real dispatch, cancels, and reconnects", async () => {
	const fixture = await createLocalMcpFixture(os.tmpdir())
	const readEffects = () =>
		fs.readFile(path.join(fixture.directory, "effect.txt"), "utf8").catch((error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") return undefined
			throw error
		})
	try {
		for (let iteration = 0; iteration < 2; iteration++) {
			const child = spawn(fixture.configuration.command, fixture.configuration.args, {
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				env: { ...process.env, ...fixture.configuration.env },
			})
			const closed = new Promise<void>((resolve, reject) => {
				child.once("close", () => resolve())
				child.once("error", reject)
			})
			void closed.catch(() => undefined)
			let stderr = ""
			child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()))
			const pending = new Map<number, (value: Record<string, unknown>) => void>()
			const lines = createInterface({ input: child.stdout })
			lines.on("line", (line) => {
				const message = JSON.parse(line) as Record<string, unknown>
				pending.get(Number(message.id))?.(message)
				pending.delete(Number(message.id))
			})
			let id = 0
			const request = (method: string, params: Record<string, unknown> = {}) => {
				const requestId = ++id
				const result = new Promise<Record<string, unknown>>((resolve, reject) => {
					const timeout = setTimeout(() => {
						pending.delete(requestId)
						reject(new Error(`Local MCP fixture did not settle ${method}`))
					}, 5_000)
					pending.set(requestId, (value) => {
						clearTimeout(timeout)
						resolve(value)
					})
				})
				child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n")
				return { requestId, result }
			}
			try {
				const initialized = await request("initialize", { protocolVersion: "2025-03-26" }).result
				assert.ok(initialized.result)
				const offered = (await request("tools/list").result).result as { tools: Array<{ name: string }> }
				assert.deepEqual(
					offered.tools.map(({ name }) => name),
					[
						...Array.from({ length: 8 }, (_, index) => `calendar_lookup_${String(index).padStart(2, "0")}`),
						"fixture_write",
						"fixture_wait",
					],
				)
				const effectsBeforeInvalidCalls = await readEffects()
				const invalid = [
					{ method: "resources/list", params: { cursor: "template-page-2" } },
					{ method: "resources/list", params: { cursor: "" } },
					{ method: "resources/templates/list", params: { cursor: "resource-page-2" } },
					{ method: "resources/read", params: { uri: "fixture:///unlisted" } },
					{ method: "resources/read", params: { uri: 7 } },
					{ method: "tools/call", params: { name: "calendar_lookup_missing", arguments: {} } },
					{ method: "tools/call", params: { name: "fixture_write", arguments: { query: 7 } } },
					{ method: "tools/call", params: { name: "fixture_write", arguments: { unexpected: true } } },
					{ method: "tools/call", params: { name: "fixture_write", arguments: [] } },
					{ method: "tools/call", params: { name: "fixture_write", arguments: null } },
				]
				for (const { method, params } of invalid) {
					const rejected = await request(method, params).result
					assert.equal(rejected.result, undefined, `${method} must reject invalid identities or arguments`)
					assert.equal((rejected.error as { code?: number } | undefined)?.code, -32602)
				}
				assert.equal(await readEffects(), effectsBeforeInvalidCalls, "Invalid calls must have no write effect")
				const catalogs = [
					{
						method: "resources/list",
						first: {
							resources: [{ uri: "fixture:///first", name: "first" }],
							nextCursor: "resource-page-2",
						},
						second: { resources: [{ uri: "fixture:///second", name: "second" }] },
					},
					{
						method: "resources/templates/list",
						first: {
							resourceTemplates: [{ uriTemplate: "fixture:///first/{id}", name: "first-template" }],
							nextCursor: "template-page-2",
						},
						second: {
							resourceTemplates: [{ uriTemplate: "fixture:///second/{id}", name: "second-template" }],
						},
					},
				]
				for (const { method, first, second } of catalogs) {
					assert.deepEqual((await request(method).result).result, first)
					assert.deepEqual((await request(method, { cursor: first.nextCursor }).result).result, second)
				}
				const contents = await request("resources/read", { uri: "fixture:///second" }).result
				assert.match(JSON.stringify(contents), /LOCAL_MCP_RESOURCE_CONTENT/)
				assert.deepEqual((contents.result as { contents: unknown[] }).contents, [
					{ uri: "fixture:///second", mimeType: "text/plain", text: "LOCAL_MCP_RESOURCE_CONTENT" },
				])
				for (const name of ["calendar_lookup_00", "fixture_write"]) {
					const invocation = await request("tools/call", { name, arguments: { query: "authorized" } }).result
					assert.deepEqual(invocation.result, { content: [{ type: "text", text: "LOCAL_MCP_TOOL_RESULT" }] })
				}
				const emptyArguments = await request("tools/call", { name: "calendar_lookup_00", arguments: {} }).result
				assert.deepEqual(emptyArguments.result, { content: [{ type: "text", text: "LOCAL_MCP_TOOL_RESULT" }] })
				const waiting = request("tools/call", { name: "fixture_wait" })
				child.stdin.write(
					JSON.stringify({
						jsonrpc: "2.0",
						method: "notifications/cancelled",
						params: { requestId: waiting.requestId, reason: "Owned cancellation" },
					}) + "\n",
				)
				assert.match(JSON.stringify(await waiting.result), /Fixture request cancelled/)
			} finally {
				child.stdin.end()
				await closed
				lines.close()
				assert.equal(child.exitCode, 0, stderr)
			}
		}
		const events = await fixture.readEvents()
		assert.equal(events.filter((event) => event.method === "started").length, 2)
		assert.equal(events.filter((event) => event.method === "notifications/cancelled").length, 2)
		assert.equal(
			await fs.readFile(path.join(fixture.directory, "effect.txt"), "utf8"),
			"one authorized effect\none authorized effect\n",
		)
	} finally {
		await fixture.dispose()
	}
})
