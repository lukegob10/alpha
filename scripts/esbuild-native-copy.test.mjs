import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import path from "node:path"
import { Readable } from "node:stream"
import { mock, test } from "node:test"
import { runInNewContext } from "node:vm"

// Execute the build owner's real function without starting the esbuild entrypoint.
const source = readFileSync(new URL("../src/esbuild.mjs", import.meta.url), "utf8")
const start = source.search(/(?:async )?function copyLanceDbNativeBindings\(/u)
const end = source.indexOf("\nasync function main()", start)
assert.ok(start >= 0 && end > start, "The native copy build owner must be available")
const copySource = `(${source.slice(start, end).trim()})`

function fixture({ code = "EPERM", platform = "win32", exists = true, identical = false, unreadable } = {}) {
	const binding = path.join("dependency", "lancedb.win32-x64-msvc.node")
	const destination = path.join("dist", path.basename(binding))
	const bytes = Buffer.alloc(256 * 1024, 0x61)
	const oldBytes = Buffer.from(bytes)
	if (!identical) oldBytes[oldBytes.length - 1] = 0x62
	const copyError = Object.assign(new Error("native binding copy failed"), { code })
	const fs = {
		mkdirSync: mock.fn(),
		copyFileSync: mock.fn(() => {
			if (code) throw copyError
		}),
		existsSync: mock.fn(() => exists),
		createReadStream: mock.fn((file) => {
			const contents = file === binding ? bytes : oldBytes
			return Readable.from(
				(async function* () {
					if (file === unreadable) throw Object.assign(new Error("cannot read binding"), { code: "EIO" })
					for (let offset = 0; offset < contents.length; offset += 64 * 1024)
						yield contents.subarray(offset, offset + 64 * 1024)
				})(),
			)
		}),
	}
	const console = { log: mock.fn(), warn: mock.fn() }
	const copy = runInNewContext(copySource, { fs, path, createHash, console, process: { platform } })
	return { binding, destination, copyError, fs, console, run: () => copy("dist", [binding]) }
}

for (const code of ["EPERM", "EBUSY"]) {
	test(`${code} refuses a locked binding with different bytes`, async () => {
		const current = fixture({ code })
		await assert.rejects(
			async () => current.run(),
			(error) => {
				assert.match(error.message, /locked.*match/iu)
				assert.match(error.message, /close.*retry/iu)
				assert.equal(error.cause, current.copyError)
				return true
			},
		)
		assert.equal(current.console.warn.mock.callCount(), 0)
	})

	test(`${code} accepts a byte-identical locked binding`, async () => {
		const current = fixture({ code, identical: true })
		await current.run()
		assert.equal(current.console.warn.mock.callCount(), 1)
		assert.deepEqual(
			current.fs.createReadStream.mock.calls.map(({ arguments: args }) => args[0]),
			[current.binding, current.destination],
		)
	})
}

test("an unreadable locked binding cannot be reused", async () => {
	const destination = path.join("dist", "lancedb.win32-x64-msvc.node")
	const current = fixture({ identical: true, unreadable: destination })
	await assert.rejects(async () => current.run(), /verif.*locked|locked.*verif/iu)
	assert.equal(current.console.warn.mock.callCount(), 0)
})

test("an unreadable source binding cannot authorize reuse", async () => {
	const binding = path.join("dependency", "lancedb.win32-x64-msvc.node")
	const current = fixture({ identical: true, unreadable: binding })
	await assert.rejects(async () => current.run(), /verif.*locked|locked.*verif/iu)
	assert.equal(current.console.warn.mock.callCount(), 0)
})

test("a successful copy does not read the bindings again", async () => {
	const successful = fixture({ code: null })
	await successful.run()
	assert.equal(successful.fs.copyFileSync.mock.callCount(), 1)
	assert.equal(successful.fs.createReadStream.mock.callCount(), 0)
})

for (const options of [{ exists: false }, { code: "EACCES" }, { platform: "linux" }]) {
	test(`preserves an unsupported copy failure ${JSON.stringify(options)}`, async () => {
		const current = fixture(options)
		await assert.rejects(
			async () => current.run(),
			(error) => error === current.copyError,
		)
		assert.equal(current.fs.createReadStream.mock.callCount(), 0)
	})
}
