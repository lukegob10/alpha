import assert from "node:assert/strict"
import { test } from "node:test"
import type { DownloadOptions } from "@vscode/test-electron"
import { downloadTestVSCode } from "../hostDownload"

const timeoutError = new Error("@vscode/test-electron request timeout out after 60000ms")

test("retries a VS Code resolution timeout with the same pinned host and a longer idle timeout", async () => {
	const attempts: Partial<DownloadOptions>[] = []
	const executable = await downloadTestVSCode({ version: "1.125.0" }, undefined, async (options) => {
		attempts.push(options)
		if (attempts.length === 1) throw timeoutError
		return "the-exact-host"
	})

	assert.equal(executable, "the-exact-host")
	assert.deepEqual(attempts, [
		{ version: "1.125.0", timeout: 60_000 },
		{ version: "1.125.0", timeout: 60_000 },
	])
})

test("keeps the VS Code download retry bounded", async () => {
	let attempts = 0
	await assert.rejects(
		downloadTestVSCode({ version: "1.141.0" }, undefined, async () => {
			attempts++
			throw timeoutError
		}),
		timeoutError,
	)
	assert.equal(attempts, 2)
})

test("does not retry a rejected version or a download cancelled before retry", async () => {
	const controller = new AbortController()
	const invalidVersion = new Error("Invalid version")
	let attempts = 0
	await assert.rejects(
		downloadTestVSCode({ version: "invalid", timeout: 5_000 }, undefined, async (options) => {
			attempts++
			assert.equal(options.timeout, 5_000)
			throw invalidVersion
		}),
		invalidVersion,
	)
	await assert.rejects(
		downloadTestVSCode({ version: "1.141.0" }, controller.signal, async () => {
			attempts++
			controller.abort()
			throw timeoutError
		}),
		timeoutError,
	)
	assert.equal(attempts, 2)
})
