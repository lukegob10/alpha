import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import console from "node:console"
import { createRequire } from "node:module"
import process from "node:process"
import test from "node:test"
import { clearTimeout, setImmediate, setTimeout } from "node:timers"
import { URL } from "node:url"
import { Script } from "node:vm"

const extensionRequire = createRequire(new URL("../src/package.json", import.meta.url))
const require = createRequire(import.meta.url)
const sdkRequire = createRequire(extensionRequire.resolve("@modelcontextprotocol/sdk/client/index.js"))
const ajvRequire = createRequire(sdkRequire.resolve("ajv"))
const expressRequire = createRequire(sdkRequire.resolve("express"))
const mochaRequire = createRequire(
	createRequire(new URL("../apps/vscode-e2e/package.json", import.meta.url)).resolve("mocha"),
)
const uri = ajvRequire("fast-uri")
const serialize = mochaRequire("serialize-javascript")
const modules = {
	undici: extensionRequire.resolve("undici"),
	bodyParser: expressRequire.resolve("body-parser"),
}

async function isolatedProbe(name, probe, mode) {
	const source = `(${probe.toString()})(${JSON.stringify(modules)}, ${JSON.stringify(mode)})
.then(() => console.log('PROBE_OK:${name}'))
.catch(error => { console.error(error); process.exitCode = 1 })`
	const result = await new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["--max-old-space-size=128", "-e", source], {
			stdio: ["ignore", "pipe", "pipe"],
			windowsHide: true,
		})
		let stdout = ""
		let stderr = ""
		let failure
		const timer = setTimeout(() => {
			failure = new Error(`${name} exceeded its isolated process deadline`)
			child.kill()
		}, 10_000)
		const collect = (kind, bytes) => {
			if (failure) return
			if (stdout.length + stderr.length + bytes.length > 65_536) {
				failure = new Error(`${name} exceeded its diagnostic output limit`)
				child.kill()
				return
			}
			if (kind === "stdout") stdout += bytes.toString("utf8")
			else stderr += bytes.toString("utf8")
		}
		child.stdout.on("data", (bytes) => collect("stdout", bytes))
		child.stderr.on("data", (bytes) => collect("stderr", bytes))
		child.once("error", (error) => {
			failure = error
		})
		child.once("close", (code, signal) => {
			clearTimeout(timer)
			if (failure) reject(failure)
			else resolve({ code, signal, stdout, stderr })
		})
	})
	assert.ok(result.stdout.includes("CONTROL_OK"), `${name} normal control failed: ${result.stderr}`)
	assert.equal(result.code, 0, `${name} failed (${result.signal || "exit"}): ${result.stderr}`)
	assert.ok(result.stdout.includes(`PROBE_OK:${name}`), `${name} did not complete cleanup`)
}

// Undici 6.x regressions: 1325a87dfb3492f8e87e6b0a84b3bda4e82e3436 and
// c43b23fdc6b37e1283d4347408bb16800f867d9e. No process-level error handlers mask crashes.
async function fetchEncodingProbe(paths) {
	const assert = require("node:assert/strict")
	const { createServer } = require("node:net")
	const { once } = require("node:events")
	const { fetch, Client } = paths.undici ? require(paths.undici) : { fetch: globalThis.fetch }
	const sockets = new Set()
	let badClosed
	const closed = new Promise((resolve) => {
		badClosed = resolve
	})
	const server = createServer((socket) => {
		sockets.add(socket)
		let request = ""
		socket.on("data", (bytes) => {
			request += bytes.toString("ascii")
			if (!request.includes("\r\n\r\n")) return
			if (request.startsWith("GET /control ")) {
				socket.end("HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
			} else {
				socket.once("close", badClosed)
				socket.end(
					"HTTP/1.1 200 OK\r\nContent-Encoding: gzip, gzip, gzip, gzip, gzip, gzip\r\nContent-Length: 1\r\nConnection: close\r\n\r\n",
				)
			}
		})
		socket.once("close", () => sockets.delete(socket))
	})
	let client
	try {
		await once(server.listen(0, "127.0.0.1"), "listening")
		const origin = `http://127.0.0.1:${server.address().port}`
		client = Client ? new Client(origin) : undefined
		assert.equal(await (await fetch(`${origin}/control`, { dispatcher: client })).text(), "ok")
		console.log("CONTROL_OK")
		await assert.rejects(fetch(`${origin}/bad`, { dispatcher: client }), (error) => {
			assert.match(error.cause?.message || "", /content-encoding/u)
			return true
		})
		await closed
		await new Promise(setImmediate)
	} finally {
		await client?.destroy()
		for (const socket of sockets) socket.destroy()
		await new Promise((resolve) => server.close(resolve))
	}
}

async function eventSourceProbe(paths, mode) {
	const assert = require("node:assert/strict")
	const { createServer } = require("node:http")
	const { once } = require("node:events")
	const { gzipSync } = require("node:zlib")
	const { Agent, EventSource } = require(paths.undici)
	let response
	const server = createServer((req, res) => {
		if (req.url === "/control") {
			res.writeHead(200, { "Content-Type": "text/event-stream" })
			res.write("data: safe\n\n")
		} else {
			response = res
			res.writeHead(200, { "Content-Type": "text/event-stream", "Content-Encoding": "gzip" })
			res.flushHeaders()
		}
	})
	const agent = new Agent({ eventSource: { maxEventSize: 4096 }, maxResponseSize: 256 * 1024 })
	let source
	try {
		await once(server.listen(0, "127.0.0.1"), "listening")
		const origin = `http://127.0.0.1:${server.address().port}`
		source = new EventSource(`${origin}/control`, { dispatcher: agent })
		const [message] = await once(source, "message", { signal: globalThis.AbortSignal.timeout(2000) })
		assert.equal(message.data, "safe")
		source.close()
		console.log("CONTROL_OK")
		source = new EventSource(`${origin}/bad`, { dispatcher: agent })
		await once(source, "open", { signal: globalThis.AbortSignal.timeout(2000) })
		let messages = 0
		source.addEventListener("message", () => {
			messages++
		})
		const error = once(source, "error", { signal: globalThis.AbortSignal.timeout(2000) })
		const data = mode === "fields" ? "data:\n".repeat(1025) : `data: ${"A".repeat(8192)}`
		response.write(gzipSync(data))
		await error
		assert.equal(source.readyState, EventSource.CLOSED)
		assert.equal(messages, 0)
	} finally {
		source?.close()
		server.closeAllConnections()
		await agent.destroy()
		await new Promise((resolve) => server.close(resolve))
	}
}

// body-parser 2.x f7075eae3a84c3473ab4bf0a777da28db208e916: release the decoder
// before delayed trailing bytes arrive, while allowing downstream request consumers to finish.
async function compressedBodyProbe(paths) {
	const assert = require("node:assert/strict")
	const http = require("node:http")
	const { once } = require("node:events")
	const { gzipSync } = require("node:zlib")
	const { Buffer } = require("node:buffer")
	const parser = require(paths.bodyParser).json()
	let client
	const trailing = Buffer.alloc(100 * 1024, 0x58)
	const server = http.createServer((req, res) => {
		parser(req, res, (error) => {
			if (error) {
				res.writeHead(400).end(error.message)
				return
			}
			if (req.url === "/bad") {
				req.once("end", () => res.end(JSON.stringify(req.body)))
				client.end(trailing)
			} else res.end(JSON.stringify(req.body))
		})
	})
	try {
		await once(server.listen(0, "127.0.0.1"), "listening")
		const send = (route, bad) =>
			new Promise((resolve, reject) => {
				const frame = gzipSync(Buffer.from('{"a":1}'))
				const first = bad ? Buffer.concat([frame, Buffer.from([0])]) : frame
				client = http.request(
					{
						host: "127.0.0.1",
						port: server.address().port,
						path: route,
						method: "POST",
						agent: false,
						headers: {
							"Content-Type": "application/json",
							"Content-Encoding": "gzip",
							"Content-Length": first.length + (bad ? trailing.length : 0),
						},
					},
					(res) => {
						let body = ""
						res.setEncoding("utf8")
						res.on("data", (chunk) => {
							body += chunk
						})
						res.once("error", reject)
						res.once("end", () => resolve({ status: res.statusCode, body }))
					},
				)
				client.once("error", reject)
				client.setTimeout(2000, () => client.destroy(new Error("compressed request did not finish")))
				if (bad) client.write(first)
				else client.end(first)
			})
		assert.deepEqual(await send("/control", false), { status: 200, body: '{"a":1}' })
		console.log("CONTROL_OK")
		assert.deepEqual(await send("/bad", true), { status: 200, body: '{"a":1}' })
	} finally {
		client?.destroy()
		server.closeAllConnections()
		await new Promise((resolve) => server.close(resolve))
	}
}

test("undici rejects excessive encodings without crashing after an early close", { timeout: 15_000 }, () =>
	isolatedProbe("fetch", fetchEncodingProbe),
)
for (const mode of ["fields", "unfinished"]) {
	test(`undici bounds compressed EventSource ${mode}`, { timeout: 15_000 }, () =>
		isolatedProbe(`eventsource-${mode}`, eventSourceProbe, mode),
	)
}
test("body-parser survives trailing compressed bytes and completes the request", { timeout: 15_000 }, () =>
	isolatedProbe("body-parser", compressedBodyProbe),
)

// The four fast-uri 3.1.9 advisories cover encoded schemes, relative paths,
// host canonicalization and suffix references; serialization regression is GHSA-m5mm-p8h7-m29v.
test("fast-uri rejects encoded schemes without changing ordinary URI handling", () => {
	assert.equal(uri.normalize("HTTPS://example.invalid:443/a"), "https://example.invalid/a")
	for (const input of ["%6Aavascript:alert(1)", "%u006Aavascript:alert(1)", "%64ata:text/html,x"]) {
		assert.ok(uri.parse(input).error, input)
		assert.equal(uri.normalize(input), input)
		assert.throws(() => uri.resolve("https://example.invalid/app/", input), /scheme is malformed/u)
	}
})

test("fast-uri preserves relative reference meaning during normalization", () => {
	const base = "https://example.invalid/a/b/"
	assert.equal(uri.resolve(base, "leaf"), `${base}leaf`)
	for (const input of ["a/../b", "../x"])
		assert.equal(uri.resolve(base, uri.normalize(input)), uri.resolve(base, input))
})

test("fast-uri rejects ambiguous hosts while retaining legal userinfo", () => {
	assert.equal(uri.parse("http://user@example.invalid/").host, "example.invalid")
	assert.equal(uri.parse("http://user@example.invalid/").error, undefined)
	for (const input of ["http://a@b@evil.invalid/", "http://exa\tmple.invalid/"])
		assert.ok(uri.parse(input).error, input)
})

test("fast-uri suffix references cannot synthesize an executable scheme", () => {
	const options = { reference: "suffix", scheme: "x" }
	for (const input of ["safe/path", "a/b:c"]) {
		assert.equal(uri.serialize({ scheme: "x", path: input }, options), input)
		assert.equal(uri.normalize(input, options), input)
	}
	// Suffix serialization suppresses the supplied scheme. Its retained path must
	// stay relative; string normalization uses upstream's explicit scheme override.
	for (const input of ["javascript:alert(1)", "data:text/html,x", "vbscript:msgbox(1)"]) {
		for (const skipEscape of [false, true]) {
			const output = uri.serialize({ scheme: "x", path: input }, { ...options, skipEscape })
			assert.equal(new URL(output, "https://example.invalid/").origin, "https://example.invalid")
		}
		assert.equal(
			new URL(uri.normalize(input, options), "https://example.invalid/").origin,
			"https://example.invalid",
		)
	}
})

test("serialize-javascript escapes a function-terminal script close and retains normal values", () => {
	const ordinary = new Script(
		`(${serialize({
			value: "</script>",
			increment: function (x) {
				return x + 1
			},
		})})`,
	).runInNewContext()
	assert.equal(ordinary.value, "</script>")
	assert.equal(ordinary.increment(2), 3)
	function f() {}
	function g() {}
	f.toString = () => "function f(){ return 1 }//</script"
	g.toString = () => "function g(x){ return x } > <img src=x onerror=alert(1)>"
	assert.doesNotMatch(serialize({ a: { f }, g }, { space: 2 }), /<\/script(?:[\t\n\f\r />]|$)/iu)
})
