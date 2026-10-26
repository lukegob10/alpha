import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it } from "vitest"

import { captureRunEvidence } from "../../../../../apps/vscode-e2e/src/evidence/capture"
import { readBounded } from "../../../../../apps/vscode-e2e/src/evidence/paths"
import { compareLiveProviderIdentity } from "../../../../../apps/vscode-e2e/src/liveProviderIdentity"
import { FilesystemArtifactStore } from "../../evidence/artifactStore"
import { canonicalJson, sha256 } from "../../evidence/canonical"
import { importHostEvidence, parseHostEvidenceObservation, validateHostEvidenceObservation } from "../hostEvidence"

const roots: string[] = []
afterEach(async () => {
	for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function fixture() {
	const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "host-improvement-")))
	roots.push(root)
	const campaignId = "live-fixture"
	const attemptId = "sample-1"
	const runId = `${sha256(campaignId).slice(7)}-${attemptId}-run`
	const source = path.join(root, "storage")
	const task = path.join(source, "tasks", "task-1")
	await fs.mkdir(task, { recursive: true })
	const privateText = "original-task-content-is-private"
	const events = [
		{
			type: "phase_changed",
			sequence: 1,
			taskId: "task-1",
			turnId: "turn-1",
			payload: { status: "running", text: privateText },
		},
		{
			type: "turn_terminal",
			sequence: 2,
			taskId: "task-1",
			turnId: "turn-1",
			payload: { status: "failed", text: privateText },
		},
	]
	for (const name of ["agent_lifecycle_events.jsonl", "agent_turn_events.jsonl"])
		await fs.writeFile(path.join(task, name), events.map((event) => JSON.stringify(event)).join("\n") + "\n")
	await fs.writeFile(
		path.join(task, "api_conversation_history.json"),
		JSON.stringify([{ role: "assistant", content: [{ type: "text", text: privateText }] }]),
	)
	await fs.writeFile(path.join(source, "agent_control.json"), JSON.stringify({ agents: [] }))
	const entrypoint = path.join(root, "extension.js")
	await fs.writeFile(entrypoint, "// retained fixture entrypoint\n")
	const startedAt = "2026-10-23T12:00:00.000Z"
	const finishedAt = "2026-10-23T12:01:00.000Z"
	const capture = await captureRunEvidence({
		artifactsRoot: path.join(root, "host-evidence"),
		runId,
		metadata: {
			scenarioId: "cancel-resume",
			hostVersion: "1.138.0",
			requestedHostVersion: "1.138.0",
			provider: "live-copilot",
			modelId: "fixture-model",
			reasoningEffort: "high",
			taskIds: ["task-1"],
			startedAt,
			finishedAt,
			outcome: "failed",
		},
		storagePath: source,
		bundlePath: entrypoint,
		failure: { phase: "assertion", code: "assertion_failed" },
		assertSourceOwned: async (candidate) => {
			if (!path.resolve(candidate).startsWith(root + path.sep)) throw new Error("outside fixture")
		},
	})
	const providerIdentity = compareLiveProviderIdentity(
		{ id: "github.copilot-chat", version: "1.0.0", entrypointSha256: "a".repeat(64) },
		{ id: "github.copilot-chat", version: "1.0.0", entrypointSha256: "a".repeat(64) },
	)
	const usage = { requests: 1, inputTokens: null, outputTokens: null, cost: null }
	const request = {
		campaignId,
		attemptId,
		scenarioId: "cancel-resume",
		phase: "sample",
		sample: 0,
		provider: { mode: "live-copilot", modelId: "fixture-model", effort: "high" },
		host: { version: "1.138.0" },
		requestLimit: 5,
	}
	const report = {
		version: 1,
		id: campaignId,
		startedAt,
		finishedAt,
		requestedProvider: request.provider,
		evaluationIdentity: {
			extensionCommit: "b".repeat(40),
			workingTreeDigest: "c".repeat(64),
			extensionBuildDigest: "d".repeat(64),
			harnessDigest: "e".repeat(64),
			configDigest: "f".repeat(64),
			taskSetDigest: "1".repeat(64),
			sourceComponentsDigest: "2".repeat(64),
			unchanged: true,
			missing: [],
		},
		attempts: [{ request, result: { status: "failed", usage }, evidence: `${attemptId}/evidence-index.json` }],
	}
	const nonce = "12345678-1234-1234-1234-123456789abc"
	const host = {
		schemaVersion: 1,
		launchKind: "development-sidecar",
		runId,
		nonce,
		actualVSCodeVersion: "1.138.0",
		pid: 100,
		ppid: 90,
	}
	const runner = {
		runId,
		status: "failed",
		providerMode: "live-copilot",
		actualVSCodeVersion: "1.138.0",
		actualModelId: "fixture-model",
		actualReasoningEffort: "high",
		execution: "extension-host",
		hostExitObserved: true,
		ownershipGate: "verified",
		captureComplete: capture.captureComplete,
		extensionHostPid: 100,
		extensionHostParentPid: 90,
		launchedHostPid: 90,
		profileDir: path.join(root, "profile"),
		providerIdentity,
	}
	const directory = `host-evidence/${runId}`
	const write = async (relative: string, value: unknown) => {
		const absolute = path.join(root, ...relative.split("/"))
		await fs.mkdir(path.dirname(absolute), { recursive: true })
		await fs.writeFile(absolute, JSON.stringify(value))
	}
	await write("report-00001.json", report)
	await write(`${attemptId}/evidence-index.json`, {
		schemaVersion: 1,
		manifests: [`${directory}/manifest.json`],
		admissions: [],
	})
	await write(`${directory}/run-result.json`, runner)
	await write(`${directory}/live-host-started.json`, { ...host, status: "started" })
	await write(`${directory}/host-completion.json`, { ...host, status: "failed", failure: "host-failed" })
	await write(`${directory}/retention-result.json`, {
		schemaVersion: 1,
		runId,
		status: "complete",
		eligibility: "held",
		maintenance: "campaign-owned",
	})
	await write(`${directory}/workflow-result.json`, {
		schemaVersion: 1,
		runId,
		scenarioId: "cancel-resume",
		phase: "run",
		status: "failed",
		hostVersion: "1.138.0",
		providerMode: "live-copilot",
		model: { id: "fixture-model", reasoningEffort: "high" },
		checks: [{ name: "cancelled-effect-is-terminal", passed: false }],
		taskIds: ["task-1"],
		requestsUsed: 1,
		failure: { category: "assertion", code: "assertion_failed" },
	})
	const store = new FilesystemArtifactStore(path.join(root, "cas"))
	const input = { id: "host-observed-1", reportPath: "report-00001.json", attemptId }
	const ports = {
		readFile: (relative: string, maximum: number) => readBounded(path.join(root, ...relative.split("/")), maximum),
		store,
		now: new Date("2026-10-23T13:00:00.000Z"),
		secrets: [privateText],
	}
	return { root, report, runner, write, input, ports, directory, capture, privateText }
}

describe("retained native host observations", () => {
	it("imports real captureRunEvidence projections while preserving failed/null observations and unavailable rich evidence", async () => {
		const { input, ports, privateText } = await fixture()
		const observation = await importHostEvidence(input, ports)
		expect(observation.campaignStatus).toBe("failed")
		expect(observation.phases[0]?.status).toBe("failed")
		expect(observation.phases[0]?.usage.cost).toBeNull()
		expect(observation.unavailableWholeBundle).toContain("transcript")
		expect(observation.unavailableWholeBundle).toContain("final_diff")
		expect(observation.semanticGradingEligible).toBe(false)
		expect(observation.regressionGenerationEligible).toBe(false)
		expect(observation).not.toHaveProperty("trialId")
		expect(canonicalJson(observation)).not.toContain(privateText)
		expect(canonicalJson(observation)).not.toContain("profileDir")
		for (const phase of observation.phases)
			for (const { descriptor } of phase.artifacts) {
				const bytes = await ports.store.get(descriptor)
				expect(bytes).toBeDefined()
				expect(new TextDecoder().decode(bytes)).not.toContain(privateText)
			}
		expect(await validateHostEvidenceObservation(observation, ports.store)).toEqual(observation)
	})

	it("rejects artifact replacement and other-attempt index references", async () => {
		const { input, ports, capture, write, report } = await fixture()
		const manifest = JSON.parse(await fs.readFile(capture.manifestPath, "utf8"))
		const first = manifest.artifacts[0] as { path: string }
		await fs.writeFile(path.join(capture.artifactDirectory, first.path), "{}")
		await expect(importHostEvidence(input, ports)).rejects.toThrow("integrity or identity")
		report.attempts[0]!.evidence = "other/evidence-index.json"
		await write("report-00001.json", report)
		await expect(importHostEvidence(input, ports)).rejects.toThrow("integrity or identity")
	})

	it.each(["model", "host", "pid", "source"])("rejects mismatched %s provenance", async (mismatch) => {
		const { input, ports, runner, directory, write, report } = await fixture()
		if (mismatch === "model") runner.actualModelId = "other-model"
		if (mismatch === "host") runner.actualVSCodeVersion = "1.125.0"
		if (mismatch === "pid") runner.extensionHostPid = 101
		if (mismatch === "source") report.evaluationIdentity.unchanged = false
		await write(`${directory}/run-result.json`, runner)
		await write("report-00001.json", report)
		await expect(importHostEvidence(input, ports)).rejects.toThrow("integrity or identity")
	})

	it("rejects tampered observation records and missing retained CAS bytes", async () => {
		const { input, ports, root } = await fixture()
		const observation = await importHostEvidence(input, ports)
		expect(() => parseHostEvidenceObservation({ ...observation, semanticGradingEligible: true })).toThrow()
		const artifact = observation.phases[0]?.artifacts[0]?.descriptor
		if (!artifact) throw new Error("Fixture must retain a projected artifact")
		const hex = artifact.digest.slice(7)
		await fs.rm(path.join(root, "cas", "sha256", hex.slice(0, 2), hex))
		await expect(validateHostEvidenceObservation(observation, ports.store)).rejects.toThrow("artifact integrity")
	})

	it("rejects unsafe source paths and bounded reader violations", async () => {
		const { input, ports } = await fixture()
		await expect(importHostEvidence({ ...input, reportPath: "../report.json" }, ports)).rejects.toThrow(
			"integrity or identity",
		)
		await expect(
			importHostEvidence(input, { ...ports, readFile: async () => new Uint8Array(4 * 1024 * 1024 + 1) }),
		).rejects.toThrow("integrity or identity")
	})
})
