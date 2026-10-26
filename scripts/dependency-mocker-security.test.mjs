import assert from "node:assert/strict"
import { Buffer } from "node:buffer"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import test from "node:test"
import { pathToFileURL, URL } from "node:url"

const extensionRequire = createRequire(new URL("../src/package.json", import.meta.url))
const vitestRequire = createRequire(extensionRequire.resolve("vitest"))
const { createManualModuleSource, interceptorPlugin } = await import(
	pathToFileURL(vitestRequire.resolve("@vitest/mocker/node")).href
)

// Vitest's 4.1.12 backport b825313243dc55757e8d7c0f9e7a792135e13473 fixes
// GHSA-qxg6-89mg-rqv8 and GHSA-xp26-3454-mjgp at these public boundaries.
async function importManualMock(url, exports, check) {
	const accessor = `alpha-mocker-fixture-${randomUUID()}`
	const requested = []
	globalThis[accessor] = {
		getFactoryModule(moduleUrl) {
			requested.push(moduleUrl)
			return Promise.resolve(exports)
		},
	}
	try {
		const source = createManualModuleSource(url, Object.keys(exports), JSON.stringify(accessor))
		const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`)
		await check(module, requested)
	} finally {
		delete globalThis[accessor]
	}
}

test("mocker keeps a registered module URL as data instead of executing it", async () => {
	const marker = `alpha-mocker-injection-${randomUUID()}`
	const url = `x"); globalThis[${JSON.stringify(marker)}] = true; void("`
	try {
		await importManualMock(url, { safe: "fixture export" }, (module, requested) => {
			assert.equal(globalThis[marker], undefined, "the registered URL must not inject a module statement")
			assert.deepEqual(requested, [url])
			assert.equal(module.safe, "fixture export")
		})
	} finally {
		delete globalThis[marker]
	}
})

test("mocker preserves quoted export names in generated JavaScript", async () => {
	const name = 'quoted" export\\name\n雪'
	await importManualMock("fixture:manual", { [name]: "named export" }, (module, requested) => {
		assert.deepEqual(requested, ["fixture:manual"])
		assert.equal(module[name], "named export")
	})
})

test("mocker rejects slash and Windows-backslash redirects before registry admission", () => {
	const root = "/alpha-mocker-fixture/root"
	const handlers = new Map()
	const registered = []
	const plugin = interceptorPlugin({ registry: { register: (event) => registered.push(event) } })
	plugin.configureServer({
		config: {
			root,
			server: { fs: { strict: true, allow: [root] } },
			fsDenyGlob: () => false,
			safeModulePaths: new Set(),
		},
		ws: { on: (event, handler) => handlers.set(event, handler), send() {} },
	})
	const register = handlers.get("vitest:interceptor:register")
	assert.equal(typeof register, "function")
	register({ type: "redirect", raw: "", id: "/inside", url: "/inside", redirect: "fixture:inside.txt" })
	assert.equal(registered.length, 1, "ordinary allowlisted redirects remain supported")
	assert.equal(registered[0].redirect, `${root}/inside.txt`)
	for (const redirect of ["fixture:../secret.txt", "fixture:..\\secret.txt"]) {
		register({ type: "redirect", raw: "", id: "/outside", url: "/outside", redirect })
		assert.equal(registered.length, 1, `${redirect} must be rejected before file loading`)
	}
})
