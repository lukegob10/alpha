import assert from "node:assert/strict"
import { createServer } from "node:http"
import { createRequire } from "node:module"
import { test } from "node:test"

const extensionRequire = createRequire(new URL("../src/package.json", import.meta.url))
const { StreamableHTTPClientTransport } = extensionRequire("@modelcontextprotocol/sdk/client/streamableHttp.js")
const { SSEClientTransport } = extensionRequire("@modelcontextprotocol/sdk/client/sse.js")
const redirectHttp = createRequire(extensionRequire.resolve("axios"))("follow-redirects").http
const notification = { jsonrpc: "2.0", method: "notifications/initialized" }

async function withServer(handler, run) {
	const server = createServer(handler)
	await new Promise((resolve, reject) => {
		server.once("error", reject)
		server.listen(0, "127.0.0.1", resolve)
	})
	const address = server.address()
	assert.ok(address && typeof address === "object")
	try {
		return await run(`http://127.0.0.1:${address.port}`)
	} finally {
		await new Promise((resolve, reject) => {
			server.close((error) => (error ? reject(error) : resolve()))
			server.closeAllConnections()
		})
	}
}

for (const kind of ["streamable-http", "sse"]) {
	test(`MCP ${kind} refuses a cross-origin redirect before sending custom credentials`, async () => {
		const foreignRequests = []
		await withServer(
			(request, response) => {
				foreignRequests.push(request.headers)
				request.resume()
				response.writeHead(kind === "sse" ? 500 : 202).end()
			},
			async (foreignUrl) => {
				await withServer(
					(request, response) => {
						request.resume()
						response.writeHead(307, { Location: `${foreignUrl}/collector` }).end()
					},
					async (serverUrl) => {
						const headers = { "X-API-Key": "fixture-credential" }
						const transport =
							kind === "sse"
								? new SSEClientTransport(new URL(serverUrl), {
										requestInit: { headers },
										// Match Alpha's custom EventSource fetch path, preserving the SDK's init.
										eventSourceInit: {
											fetch: (url, init) =>
												fetch(url, { ...init, headers: new Headers(headers) }),
										},
									})
								: new StreamableHTTPClientTransport(new URL(serverUrl), { requestInit: { headers } })
						try {
							await assert.rejects(kind === "sse" ? transport.start() : transport.send(notification))
							assert.equal(foreignRequests.length, 0, "the foreign origin must receive no request")
						} finally {
							await transport.close()
						}
					},
				)
			},
		)
	})
}

test("MCP retains same-origin method-preserving redirects", async () => {
	const received = []
	await withServer(
		(request, response) => {
			request.resume()
			if (request.url === "/entry") response.writeHead(307, { Location: "/mcp" }).end()
			else {
				received.push({ method: request.method, key: request.headers["x-api-key"] })
				response.writeHead(202).end()
			}
		},
		async (serverUrl) => {
			const transport = new StreamableHTTPClientTransport(new URL(`${serverUrl}/entry`), {
				requestInit: { headers: { "X-API-Key": "fixture-credential" } },
			})
			try {
				await transport.send(notification)
				assert.deepEqual(received, [{ method: "POST", key: "fixture-credential" }])
			} finally {
				await transport.close()
			}
		},
	)
})

for (const form of ["array", "metacharacters"]) {
	test(`redirect dependency strips ${form} credential headers across origins`, async () => {
		const received = []
		await withServer(
			(request, response) => {
				received.push(request.headers)
				request.resume()
				response.end("received")
			},
			async (foreignUrl) => {
				await withServer(
					(request, response) => {
						request.resume()
						response.writeHead(302, { Location: foreignUrl }).end()
					},
					async (serverUrl) => {
						await new Promise((resolve, reject) => {
							const request = redirectHttp.get(
								serverUrl,
								{
									headers:
										form === "array"
											? [
													"Host",
													new URL(serverUrl).host,
													"Authorization",
													"fixture-credential",
													"X-Trace",
													"preserved",
												]
											: { "X-Api^Key": "fixture-credential", "X-Trace": "preserved" },
									sensitiveHeaders: ["X-Api^Key"],
								},
								(response) => {
									response.on("error", reject)
									response.on("end", resolve)
									response.resume()
								},
							)
							request.on("error", reject)
						})
						assert.equal(received.length, 1)
						assert.equal(received[0]["x-trace"], "preserved")
						assert.equal(received[0].authorization, undefined)
						assert.equal(received[0]["x-api^key"], undefined)
					},
				)
			},
		)
	})
}
