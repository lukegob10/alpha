import * as assert from "node:assert/strict"
import { test } from "node:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { captureCampaignEvaluationIdentity, finishCampaignEvaluationIdentity } from "./evaluationIdentity"
import type { CampaignConfig, CampaignEvaluationIdentity } from "./types"

const identity: CampaignEvaluationIdentity = {
	extensionCommit: "source",
	workingTreeDigest: "tree",
	extensionBuildDigest: "built",
	harnessDigest: "runner",
	configDigest: "config",
	taskSetDigest: "tasks",
	sourceComponentsDigest: "sources",
	unchanged: false,
	missing: [],
}
test("identity finalization rejects missing evidence and source/build drift", () => {
	assert.equal(finishCampaignEvaluationIdentity(identity, { ...identity }).unchanged, true)
	for (const field of ["extensionBuildDigest", "taskSetDigest", "harnessDigest", "workingTreeDigest"] as const) {
		const result = finishCampaignEvaluationIdentity(identity, { ...identity, [field]: "changed" })
		assert.equal(result.unchanged, false)
		assert.ok(result.missing.includes("identity_changed_during_campaign"))
	}
	assert.equal(finishCampaignEvaluationIdentity(identity, { ...identity, missing: ["source"] }).unchanged, false)
})
test("missing source and builds remain explicit; operational IDs and model selection do not alter config identity", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "alpha-identity-"))
	const config: CampaignConfig = {
		id: "first",
		hosts: [{ version: "1.122.1" }],
		scenarioIds: ["read-only"],
		samples: 1,
		provider: { mode: "scripted" },
		maxReproductions: 0,
		budgets: { maxIterations: 1, maxRequests: 2, maxDurationMs: 1000, attemptTimeoutMs: 1000 },
	}
	try {
		const before = await captureCampaignEvaluationIdentity(root, config)
		const after = await captureCampaignEvaluationIdentity(root, {
			...config,
			id: "second",
			provider: { mode: "live-copilot", modelId: "model" },
		})
		assert.equal(before.extensionCommit, null)
		assert.equal(before.extensionBuildDigest, null)
		assert.ok(before.missing.includes("harnessDigest"))
		assert.equal(before.configDigest, after.configDigest)
		assert.equal(finishCampaignEvaluationIdentity(before, after).unchanged, false)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})

test("extension build identity includes native and external runtime files, including removal", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "alpha-runtime-identity-"))
	const config: CampaignConfig = {
		id: "runtime",
		hosts: [{ version: "1.122.1" }],
		scenarioIds: ["read-only"],
		samples: 1,
		provider: { mode: "scripted" },
		maxReproductions: 0,
		budgets: { maxIterations: 1, maxRequests: 2, maxDurationMs: 1000, attemptTimeoutMs: 1000 },
	}
	try {
		for (const [relative, contents] of [
			["src/package.json", "{}"],
			["src/dist/extension.js", "bundle"],
			["src/webview-ui/build/index.html", "webview"],
			["src/dist/node_modules/@vscode/ripgrep/bin/rg.exe", "original runtime"],
		] as const) {
			const file = path.join(root, relative)
			await mkdir(path.dirname(file), { recursive: true })
			await writeFile(file, contents)
		}
		const before = await captureCampaignEvaluationIdentity(root, config)
		assert.notEqual(before.extensionBuildDigest, null)
		const external = path.join(root, "src/dist/node_modules/@vscode/ripgrep/bin/rg.exe")
		await writeFile(external, "changed runtime")
		const changed = await captureCampaignEvaluationIdentity(root, config)
		assert.notEqual(changed.extensionBuildDigest, before.extensionBuildDigest)
		await rm(external)
		const removed = await captureCampaignEvaluationIdentity(root, config)
		assert.notEqual(removed.extensionBuildDigest, before.extensionBuildDigest)
	} finally {
		await rm(root, { recursive: true, force: true })
	}
})
