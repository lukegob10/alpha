import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import {
	captureLiveProviderExtension,
	compareLiveProviderIdentity,
	isLiveProviderIdentityReceipt,
	withLiveProviderIdentity,
	type LiveProviderIdentityReceipt,
} from "../liveProviderIdentity"

test("provider receipts identify actual entrypoint bytes without retaining paths or arbitrary manifest fields", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "alpha-provider-identity-"))
	context.after(() => rm(root, { recursive: true, force: true }))
	await writeFile(join(root, "extension.js"), "// first provider build")
	const source = {
		extensionPath: root,
		packageJSON: { version: "0.66.0", main: "extension.js", secret: "PRIVATE_SENTINEL" },
	}
	const before = await captureLiveProviderExtension(source)
	assert.equal(before.version, "0.66.0")
	assert.match(before.entrypointSha256!, /^[a-f0-9]{64}$/)
	assert.deepEqual(
		await captureLiveProviderExtension({ ...source, packageJSON: { ...source.packageJSON, main: "extension" } }),
		before,
	)
	const stable = compareLiveProviderIdentity(before, await captureLiveProviderExtension(source))
	assert.equal(stable.status, "unchanged")
	assert.equal(isLiveProviderIdentityReceipt(stable), true)
	assert.equal(JSON.stringify(stable).includes(root), false)
	assert.equal(JSON.stringify(stable).includes("PRIVATE_SENTINEL"), false)
	await writeFile(join(root, "extension.js"), "// different provider build")
	const changed = compareLiveProviderIdentity(before, await captureLiveProviderExtension(source))
	assert.equal(changed.status, "changed", "same version cannot hide replaced entrypoint bytes")
	assert.equal(isLiveProviderIdentityReceipt(changed), true)
	assert.equal(isLiveProviderIdentityReceipt({ ...changed, status: "unchanged" }), false)
	assert.equal(isLiveProviderIdentityReceipt({ ...stable, before: { ...before, secret: "PRIVATE_SENTINEL" } }), false)
	assert.equal(await readFile(join(root, "extension.js"), "utf8"), "// different provider build")
})

test("missing or escaped provider builds remain unknown, including stable unknown snapshots", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "alpha-provider-unknown-"))
	context.after(() => rm(root, { recursive: true, force: true }))
	const absent = await captureLiveProviderExtension(undefined)
	assert.equal(compareLiveProviderIdentity(absent, absent).status, "unknown")
	assert.equal(isLiveProviderIdentityReceipt(compareLiveProviderIdentity(absent, absent)), true)
	const escaped = await captureLiveProviderExtension({
		extensionPath: root,
		packageJSON: { version: "0.66.0", main: "../outside.js" },
	})
	assert.equal(escaped.entrypointSha256, null)
	assert.equal(compareLiveProviderIdentity(absent, escaped).status, "unknown")
	assert.equal(
		isLiveProviderIdentityReceipt({ schemaVersion: 1, before: absent, after: escaped, status: "unchanged" }),
		false,
	)
})

test("a suite cannot pass after provider replacement and failed suites still publish their observed conditions", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "alpha-provider-run-"))
	context.after(() => rm(root, { recursive: true, force: true }))
	await writeFile(join(root, "extension.js"), "// initial build")
	const source = { extensionPath: root, packageJSON: { version: "0.66.0", main: "extension.js" } }
	const receipts: LiveProviderIdentityReceipt[] = []
	await assert.rejects(
		withLiveProviderIdentity(
			() => writeFile(join(root, "extension.js"), "// changed build"),
			() => source,
			async (receipt) => {
				receipts.push(receipt)
			},
		),
		{ code: "provider-unavailable" },
	)
	assert.equal(receipts[0]?.status, "changed")
	const failure = new Error("original suite failure")
	await assert.rejects(
		withLiveProviderIdentity(
			async () => {
				throw failure
			},
			() => source,
			async (receipt) => {
				receipts.push(receipt)
			},
		),
		(error) => error === failure,
	)
	assert.equal(receipts[1]?.status, "unchanged")
	await assert.rejects(
		withLiveProviderIdentity(
			async () => {},
			() => undefined,
			async (receipt) => {
				receipts.push(receipt)
			},
		),
		{ code: "provider-unavailable" },
	)
	assert.equal(receipts[2]?.status, "unknown")
	await withLiveProviderIdentity(
		async () => {},
		() => undefined,
		async (receipt) => {
			receipts.push(receipt)
		},
		{ setup: true },
	)
	assert.equal(
		receipts[3]?.status,
		"unknown",
		"interactive setup records changing conditions without claiming a stable evaluation",
	)
})
