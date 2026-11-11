import { execFile } from "node:child_process"
import { createRequire } from "node:module"
import { promisify } from "node:util"

const runNode = promisify(execFile)
const require = createRequire(import.meta.url)

// Exercise the installed dependency in a process that owns its HTTP monkey patches.
// Mocked adapter tests cannot detect changes to bootstrap, routing, or CONNECT behavior.
const proxyContract = String.raw`
const assert = require("node:assert/strict")
const http = require("node:http")
const https = require("node:https")
const { once } = require("node:events")
const { bootstrap } = require(process.argv[1])

async function listen(server) {
	server.listen(0, "127.0.0.1")
	await once(server, "listening")
	return server.address().port
}

function request(client, url) {
	return new Promise((resolve, reject) => {
		const pending = client.get(url, (response) => {
			let body = ""
			response.setEncoding("utf8")
			response.on("data", (chunk) => { body += chunk })
			response.on("end", () => resolve(body))
			response.on("error", reject)
		})
		pending.on("error", reject)
		pending.setTimeout(2000, () => pending.destroy(new Error("proxy request timed out")))
	})
}

;(async () => {
	const routes = []
	const proxy = http.createServer((incoming, response) => {
		routes.push(incoming.url)
		response.end("proxied")
	})
	const direct = http.createServer((_incoming, response) => response.end("direct"))
	try {
		const proxyPort = await listen(proxy)
		const directPort = await listen(direct)
		const hostProxy = process.env.HTTP_PROXY
		process.env.GLOBAL_AGENT_HTTP_PROXY = "http://127.0.0.1:" + proxyPort
		process.env.GLOBAL_AGENT_HTTPS_PROXY = process.env.GLOBAL_AGENT_HTTP_PROXY
		process.env.GLOBAL_AGENT_NO_PROXY = ""

		assert.equal(bootstrap(), true)
		const controller = global.GLOBAL_AGENT
		assert.equal(bootstrap(), false)
		assert.equal(global.GLOBAL_AGENT, controller)
		assert.equal(process.env.HTTP_PROXY, hostProxy)
		assert.equal(await request(http, "http://alpha-proxy.invalid/resource?key=value"), "proxied")
		assert.deepEqual(routes, ["http://alpha-proxy.invalid/resource?key=value"])

		controller.NO_PROXY = "127.0.0.1"
		assert.equal(await request(http, "http://127.0.0.1:" + directPort + "/direct"), "direct")
		assert.equal(routes.length, 1)

		const tunnel = once(proxy, "connect")
		const secureRequest = https.get("https://alpha-proxy.invalid/secure")
		secureRequest.on("error", () => {}) // The test owns and stops this unfinished TLS connection.
		const [incoming, socket] = await tunnel
		secureRequest.destroy()
		socket.destroy()
		assert.equal(incoming.url, "alpha-proxy.invalid:443")
		console.log("proxy contract passed")
	} finally {
		proxy.closeAllConnections()
		direct.closeAllConnections()
		await Promise.all([new Promise((resolve) => proxy.close(resolve)), new Promise((resolve) => direct.close(resolve))])
	}
})().catch((error) => {
	console.error(error)
	process.exitCode = 1
})
`

it("preserves installed global-agent bootstrap, native HTTP routing, bypasses, and HTTPS tunneling", async () => {
	const { stdout } = await runNode(process.execPath, ["-e", proxyContract, require.resolve("global-agent")], {
		timeout: 10_000,
		maxBuffer: 64 * 1024,
	})
	expect(stdout.trim()).toBe("proxy contract passed")
})
