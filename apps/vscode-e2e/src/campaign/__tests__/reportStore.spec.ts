import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { createReportStore, openCampaignRoot } from "../reportStore"
import type { CampaignReport } from "../types"

const report: CampaignReport = {
	version: 1,
	id: "sample",
	mode: "report-only",
	requestedProvider: { mode: "scripted" },
	startedAt: "2026-09-06T00:00:00.000Z",
	counts: { passed: 0, failed: 0, blocked: 0 },
	usage: { requests: 0, inputTokens: null, outputTokens: null, cost: null },
	attempts: [],
	repairs: [],
}

test("writes immutable complete checkpoints and rejects reused run IDs", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-campaign-report-"))
	try {
		await openCampaignRoot(root, true)
		assert.equal(await openCampaignRoot(root, false), await fs.realpath(root))
		const store = await createReportStore(root, "sample")
		await store.persistReport(report)
		await store.persistReport({ ...report, stopReason: "completed" })
		const files = await fs.readdir(store.directory)
		assert.deepEqual(files, ["report-00001.json", "report-00002.json"])
		assert.deepEqual(JSON.parse(await fs.readFile(path.join(store.directory, files[0]!), "utf8")), report)
		await assert.rejects(createReportStore(root, "sample"), { code: "EEXIST" })
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("refuses unmarked nonempty roots and broad directories", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-campaign-report-"))
	try {
		await fs.writeFile(path.join(root, "sentinel"), "keep")
		await assert.rejects(openCampaignRoot(root, true))
		assert.equal(await fs.readFile(path.join(root, "sentinel"), "utf8"), "keep")
		await assert.rejects(openCampaignRoot(os.homedir(), true))
		await assert.rejects(openCampaignRoot(path.parse(root).root, true))
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("rejects existing ancestor symlink before creating anything outside the root", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-campaign-report-"))
	try {
		const target = path.join(root, "outside")
		await fs.mkdir(target)
		await fs.symlink(target, path.join(root, "link"), process.platform === "win32" ? "junction" : "dir")
		await assert.rejects(openCampaignRoot(path.join(root, "link", "created"), true))
		assert.deepEqual(await fs.readdir(target), [])
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})

test("never replaces an existing checkpoint even if the next filename was occupied", async () => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-campaign-report-"))
	try {
		await openCampaignRoot(root, true)
		const store = await createReportStore(root, "sample")
		const sentinel = path.join(store.directory, "report-00001.json")
		await fs.writeFile(sentinel, "external edit")
		await assert.rejects(store.persistReport(report), { code: "EEXIST" })
		assert.equal(await fs.readFile(sentinel, "utf8"), "external edit")
	} finally {
		await fs.rm(root, { recursive: true, force: true })
	}
})
