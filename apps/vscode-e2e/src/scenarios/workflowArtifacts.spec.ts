import { strict as assert } from "node:assert"
import { test } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { createRequire } from "node:module"

import { writeNewWorkflowArtifact } from "./workflowArtifacts"

test("workflow JSON is complete before exclusive publication and cannot replace prior evidence", async (context) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-workflow-artifacts-")))
	const target = path.join(root, "nested", "workflow-result.json")
	const nativeFs = createRequire(__filename)("node:fs/promises") as typeof fs
	const originalLink = fs.link
	let publications = 0
	context.mock.method(nativeFs, "link", async (source: string, destination: string) => {
		assert.equal(destination, target)
		assert.deepEqual(JSON.parse(await fs.readFile(source, "utf8")), { status: "failed", requests: 3 })
		if (publications++ === 0) await assert.rejects(fs.stat(target), { code: "ENOENT" })
		await originalLink(source, destination)
	})
	try {
		await writeNewWorkflowArtifact(target, { status: "failed", requests: 3 })
		await assert.rejects(writeNewWorkflowArtifact(target, { status: "failed", requests: 3 }), { code: "EEXIST" })
		assert.equal(publications, 2)
		assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), { status: "failed", requests: 3 })
		assert.deepEqual(await fs.readdir(path.dirname(target)), ["workflow-result.json"])
	} finally {
		assert.match(path.basename(root), /^alpha-workflow-artifacts-/)
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("an interrupted workflow write cannot expose partial canonical JSON", async (context) => {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-workflow-artifacts-")))
	const target = path.join(root, "workflow-result.json")
	const nativeFs = createRequire(__filename)("node:fs/promises") as typeof fs
	const originalOpen = fs.open
	const failure = new Error("injected write interruption")
	context.mock.method(nativeFs, "open", async (...args: Parameters<typeof fs.open>) => {
		const handle = await originalOpen(...args)
		const originalWrite = handle.writeFile.bind(handle)
		context.mock.method(handle, "writeFile", async () => {
			await originalWrite("{")
			await assert.rejects(fs.stat(target), { code: "ENOENT" })
			throw failure
		})
		return handle
	})
	try {
		await assert.rejects(writeNewWorkflowArtifact(target, { status: "passed" }), (error) => error === failure)
		await assert.rejects(fs.stat(target), { code: "ENOENT" })
		assert.deepEqual(await fs.readdir(root), [])
	} finally {
		assert.match(path.basename(root), /^alpha-workflow-artifacts-/)
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("workflow evidence rejects relative destinations", async () => {
	await assert.rejects(writeNewWorkflowArtifact("workflow-result.json", {}), /artifact_path_not_absolute/)
})
