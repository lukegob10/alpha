import { strict as assert } from "node:assert"
import { test, type TestContext } from "node:test"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"

import { main } from "../../runCampaign"
import { campaignConfigDigest } from "../config"
import { compareLiveProviderIdentity } from "../../liveProviderIdentity"
import type { CampaignConfig, CampaignEvaluationIdentity, CampaignOperations } from "../types"

function captureOutput(context: TestContext): string[] {
	const output: string[] = []
	const write = process.stdout.write.bind(process.stdout)
	context.mock.method(process.stdout, "write", (...args: Parameters<typeof process.stdout.write>) => {
		if (typeof args[0] !== "string") return write(...args)
		output.push(args[0])
		return true
	})
	return output
}

test("matrix CLI rejects other hosts, per-model overrides and conflicting modes before filesystem effects", async () => {
	const root = path.join(os.tmpdir(), `alpha-matrix-rejected-${randomUUID()}`)
	const base = ["--model-matrix", "--suite", "core", "--provider", "live-copilot", "--root", root]
	for (const args of [
		["--vscode-version", "stable"],
		["--vscode-version", "1.125.0"],
		["--vscode-version", "1.139.1"],
		["--model-id", "gpt-6-luna"],
		["--effort", "max"],
		["--diagnose-failures"],
		["--enable-reviewed-patches"],
		["--config", "unused.json"],
		["--profile-dir", "relative-profile"],
	])
		await assert.rejects(main([...base, ...args, "--dry-run"]))
	await assert.rejects(main(["--model-matrix", "--root", root]))
	await assert.rejects(main(["--model-matrix", "--suite", "smoke", "--provider", "live-copilot", "--root", root]))
	await assert.rejects(main(["--model-matrix", "--suite", "core", "--provider", "scripted", "--root", root]))
	await assert.rejects(fs.stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
})

test("matrix dry run exposes all three exact-host configurations and their combined budget without launching", async (context) => {
	const output = captureOutput(context)
	const root = path.join(os.tmpdir(), `alpha-matrix-preview-${randomUUID()}`)
	assert.equal(
		await main([
			"--model-matrix",
			"--suite",
			"core",
			"--provider",
			"live-copilot",
			"--root",
			root,
			"--id",
			"matrix-preview",
			"--max-requests",
			"120",
			"--dry-run",
		]),
		0,
	)
	const preview = JSON.parse(output.at(-1)!)
	assert.equal(preview.kind, "alpha-live-model-matrix")
	assert.equal(preview.maxRequests, 360)
	assert.equal(preview.gate, true)
	assert.deepEqual(preview.preparation, [
		"test:unit",
		"test:smoke:1380",
		"test:core:regressions",
		"test:core:1380:run",
	])
	assert.deepEqual(
		preview.plan.campaigns.map((config: { provider: unknown }) => config.provider),
		[
			{ mode: "live-copilot", modelId: "gpt-6-luna", effort: "max" },
			{ mode: "live-copilot", modelId: "claude-haiku-5.5", effort: "high" },
			{ mode: "live-copilot", modelId: "grok-4.6", effort: "low" },
		],
	)
	for (const campaign of preview.plan.campaigns) {
		assert.deepEqual(campaign.hosts, [{ version: "1.138.0" }])
		assert.equal(campaign.samples, 1)
	}
	await assert.rejects(fs.stat(root), (error: NodeJS.ErrnoException) => error.code === "ENOENT")
})

test("cancellation during preparation retains a cancelled matrix without starting a model", async (context) => {
	captureOutput(context)
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-matrix-cancelled-")))
	const require = createRequire(__filename)
	const gate = require("../liveGate") as typeof import("../liveGate")
	const adapter = require("../extensionAdapter") as typeof import("../extensionAdapter")
	context.mock.method(gate, "prepareLiveGate", async () => {
		process.emit("SIGINT")
		throw new Error("fixture preparation cancelled after cleanup")
	})
	context.mock.method(adapter, "createExtensionCampaignOperations", () => {
		assert.fail("Cancelled preparation must not create model operations")
	})
	try {
		assert.equal(
			await main([
				"--model-matrix",
				"--suite",
				"core",
				"--provider",
				"live-copilot",
				"--root",
				root,
				"--id",
				"cancelled-matrix",
				"--init-root",
			]),
			2,
		)
		const report = JSON.parse(await fs.readFile(path.join(root, "cancelled-matrix/matrix-result.json"), "utf8"))
		assert.equal(report.status, "cancelled")
		assert.deepEqual(report.counts, { passed: 0, failed: 0, blocked: 0, notRun: 3 })
	} finally {
		assert.match(path.basename(root), /^alpha-matrix-cancelled-/)
		await fs.rm(root, { recursive: true, force: true })
	}
})

for (const drift of [false, true]) {
	test(`matrix execution shares one preparation and blocks changed conditions before another live launch (drift=${drift})`, async (context) => {
		captureOutput(context)
		const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-matrix-execution-")))
		const require = createRequire(__filename)
		const gate = require("../liveGate") as typeof import("../liveGate")
		const identity = require("../evaluationIdentity") as typeof import("../evaluationIdentity")
		const sidecar = require("../../liveHostProtocol") as typeof import("../../liveHostProtocol")
		const adapter = require("../extensionAdapter") as typeof import("../extensionAdapter")
		let preparations = 0
		let identityReads = 0
		const models: string[] = []
		context.mock.method(gate, "prepareLiveGate", async () => {
			preparations++
			return true
		})
		context.mock.method(gate, "fingerprintGateArtifacts", async () => "f".repeat(64))
		context.mock.method(sidecar, "prepareLiveSidecar", async () => path.join(root, "sidecar"))
		context.mock.method(
			identity,
			"captureCampaignEvaluationIdentity",
			async (_root: string, config: CampaignConfig): Promise<CampaignEvaluationIdentity> => ({
				extensionCommit: "a".repeat(40),
				workingTreeDigest: drift && ++identityReads >= 4 ? "0".repeat(64) : "a".repeat(64),
				extensionBuildDigest: "b".repeat(64),
				harnessDigest: "c".repeat(64),
				taskSetDigest: "d".repeat(64),
				sourceComponentsDigest: "e".repeat(64),
				configDigest: campaignConfigDigest(config),
				unchanged: false,
				missing: [],
			}),
		)
		context.mock.method(
			adapter,
			"createExtensionCampaignOperations",
			(options: Parameters<typeof adapter.createExtensionCampaignOperations>[0]): CampaignOperations => ({
				async runScenario(request) {
					assert.equal(request.host.version, "1.138.0")
					if (models.at(-1) !== request.provider.modelId) models.push(request.provider.modelId!)
					return {
						status: "passed" as const,
						usage: { requests: 1, inputTokens: null, outputTokens: null, cost: null },
						actualHostVersion: request.host.version,
						model: { id: request.provider.modelId!, effort: request.provider.effort },
						taskIds: [request.attemptId],
						providerIdentity: compareLiveProviderIdentity(
							{ id: "github.copilot-chat", version: "0.66.0", entrypointSha256: "f".repeat(64) },
							{ id: "github.copilot-chat", version: "0.66.0", entrypointSha256: "f".repeat(64) },
						),
					}
				},
				preserveEvidence: async () => "fixture/evidence-index.json",
				persistReport: options.persistReport,
				finalizeRetention: async () => ({ status: "complete" as const }),
			}),
		)
		try {
			assert.equal(
				await main([
					"--model-matrix",
					"--suite",
					"core",
					"--provider",
					"live-copilot",
					"--root",
					root,
					"--id",
					"matrix-integration",
					"--init-root",
				]),
				drift ? 2 : 0,
			)
			assert.equal(preparations, 1)
			assert.deepEqual(models, drift ? ["gpt-6-luna"] : ["gpt-6-luna", "claude-haiku-5.5", "grok-4.6"])
			const report = JSON.parse(
				await fs.readFile(path.join(root, "matrix-integration/matrix-result.json"), "utf8"),
			)
			assert.equal(report.hostVersion, "1.138.0")
			assert.equal(report.status, drift ? "blocked" : "passed")
			assert.deepEqual(
				report.counts,
				drift
					? { passed: 1, failed: 0, blocked: 1, notRun: 1 }
					: { passed: 3, failed: 0, blocked: 0, notRun: 0 },
			)
		} finally {
			assert.match(path.basename(root), /^alpha-matrix-execution-/)
			await fs.rm(root, { recursive: true, force: true })
		}
	})
}
