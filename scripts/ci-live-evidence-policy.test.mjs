import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"
import { require as tsRequire } from "tsx/cjs/api"
import { admitLiveEvidence, LIVE_EVIDENCE_MAX_AGE_MS } from "./ci-live-evidence-policy.mjs"

const { createDevelopmentSuite } = tsRequire("../apps/vscode-e2e/src/campaign/developmentSuites.ts", import.meta.url)
const { campaignConfigDigest } = tsRequire("../apps/vscode-e2e/src/campaign/config.ts", import.meta.url)
const { joinProjectedEvidence } = tsRequire("../apps/vscode-e2e/src/evidence/journalProjection.ts", import.meta.url)
const hash = (value) => createHash("sha256").update(value).digest("hex")
const now = Date.parse("2026-10-23T14:00:00Z")
const timestamp = new Date(now - 60_000).toISOString()

async function fixture(run) {
	// Admission rejects symlink components, including the macOS system-temp /var alias.
	const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "alpha-ci-live-admission-")))
	const write = async (relative, value) => {
		const destination = path.join(root, relative)
		await mkdir(path.dirname(destination), { recursive: true })
		await writeFile(destination, JSON.stringify(value, null, 2) + "\n")
	}
	try {
		const config = createDevelopmentSuite({
			suite: "core",
			id: "import-test",
			provider: "live-copilot",
			modelId: "exact-model",
			effort: "high",
		})
		const current = {
			extensionCommit: "a".repeat(40),
			workingTreeDigest: "b".repeat(64),
			extensionBuildDigest: "c".repeat(64),
			harnessDigest: "d".repeat(64),
			configDigest: campaignConfigDigest(config),
			taskSetDigest: "e".repeat(64),
			sourceComponentsDigest: "f".repeat(64),
			unchanged: false,
			missing: [],
		}
		const build = {
			bundleSha256: "1".repeat(64),
			extensionBuildDigest: current.extensionBuildDigest,
			harnessDigest: current.harnessDigest,
		}
		const providerSnapshot = { id: "github.copilot-chat", version: "1.2.3", entrypointSha256: "2".repeat(64) }
		const providerIdentity = {
			schemaVersion: 1,
			before: providerSnapshot,
			after: providerSnapshot,
			status: "unchanged",
		}
		const attempts = []
		for (const [scenarioIndex, scenarioId] of config.scenarioIds.entries()) {
			const attemptId = `sample-${scenarioIndex}`
			const request = {
				campaignId: config.id,
				attemptId,
				host: config.hosts[0],
				scenarioId,
				sample: 1,
				phase: "sample",
				provider: config.provider,
				requestLimit: 40,
			}
			const phases = scenarioId === "reload-continuation" ? ["prepare", "continue"] : ["run"]
			const manifests = []
			for (const phase of phases) {
				const runId = `${hash(config.id)}-${attemptId}-${phase}`
				const directory = `host-evidence/${runId}`
				const content = Buffer.from(JSON.stringify({ observed: true }))
				await mkdir(path.join(root, directory), { recursive: true })
				await writeFile(path.join(root, directory, "task-summary.json"), content)
				const taskId = `task-${scenarioIndex}`
				const event = {
					type: "turn_terminal",
					taskIdSha256: hash(taskId),
					runIdSha256: hash(runId),
					turnIdSha256: hash("turn"),
					stepIdSha256: hash("step"),
					sequence: 1,
					status: "completed",
				}
				const journal = {
					sourceBytes: 100,
					sourceSha256: hash("journal"),
					projection: {
						events: [event],
						captureStatus: "captured",
						validationStatus: "validated",
						complete: true,
						warnings: [],
					},
				}
				const sources = [
					"agent_lifecycle_events.jsonl",
					"agent_turn_events.jsonl",
					"api_conversation_history.json",
				]
				const projected = {
					[`${taskId}-${sources[0]}.projection.json`]: journal,
					[`${taskId}-${sources[1]}.projection.json`]: journal,
					[`${taskId}-${sources[2]}.projection.json`]: {
						sourceBytes: 100,
						sourceSha256: hash("conversation"),
						projection: [
							{ role: "assistant", tools: [{ type: "call", idSha256: hash("call") }] },
							{ role: "user", tools: [{ type: "result", idSha256: hash("call"), isError: false }] },
						],
					},
					[`${taskId}-evidence-join.json`]: {
						status: "captured",
						validation: { lifecycle: "validated", eventLog: "validated" },
						...joinProjectedEvidence({ lifecycle: [event], eventLog: [event] }),
					},
				}
				const artifacts = [{ path: "task-summary.json", bytes: content.length, sha256: hash(content) }]
				for (const [name, value] of Object.entries(projected)) {
					const bytes = Buffer.from(JSON.stringify(value))
					await writeFile(path.join(root, directory, name), bytes)
					artifacts.push({ path: name, bytes: bytes.length, sha256: hash(bytes) })
				}
				await write(`${directory}/manifest.json`, {
					kind: "alpha-vscode-e2e-run-evidence",
					version: 1,
					runId,
					finalized: true,
					captureComplete: true,
					bundleSha256: build.bundleSha256,
					warnings: [],
					metadata: {
						scenarioId,
						hostVersion: "1.138.0",
						requestedHostVersion: "1.138.0",
						provider: "live-copilot",
						modelId: "exact-model",
						reasoningEffort: "high",
						taskIds: [taskId],
						startedAt: timestamp,
						finishedAt: timestamp,
						outcome: "passed",
					},
					summary: { category: "none", code: "OK" },
					artifacts,
					taskEvidence: sources.map((file) => ({ taskId, file, status: "captured" })),
				})
				await write(`${directory}/run-result.json`, {
					runId,
					status: "passed",
					exitCode: 0,
					providerMode: "live-copilot",
					actualVSCodeVersion: "1.138.0",
					actualModelId: "exact-model",
					actualReasoningEffort: "high",
					execution: "extension-host",
					hostExitObserved: true,
					ownershipGate: "verified",
					captureComplete: true,
					requireAllTests: true,
					testCounts: { total: 1, passed: 1, failed: 0, pending: 0, executed: 1 },
					testSelection: { testFile: "workflow.test", grep: null, forbidOnly: true },
					providerIdentity,
					profileDir: path.join(root, "owned-profile"),
				})
				const host = {
					schemaVersion: 1,
					launchKind: "development-sidecar",
					runId,
					nonce: "aabbccdd-aabb-aabb-aabb-aabbccddeeff",
					actualVSCodeVersion: "1.138.0",
					pid: 123,
					ppid: 122,
				}
				await write(`${directory}/live-host-started.json`, { ...host, status: "started" })
				await write(`${directory}/host-completion.json`, { ...host, status: "passed" })
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
					scenarioId,
					phase,
					status: phase === "prepare" ? "checkpointed" : "passed",
					checks: [{ name: "independent-workspace-outcome", passed: true }],
					taskIds: [`task-${scenarioIndex}`],
					hostVersion: "1.138.0",
					providerMode: "live-copilot",
					model: { id: "exact-model", reasoningEffort: "high" },
					requestsUsed: 2,
				})
				manifests.push(`${directory}/manifest.json`)
			}
			await write(`${attemptId}/evidence-index.json`, { schemaVersion: 1, manifests, admissions: [] })
			if (scenarioId === "completion-idle") {
				await write(`${attemptId}/completion-ui-replay.json`, {
					exitCode: 0,
					signal: null,
					outputTruncated: false,
				})
				await write(`${attemptId}/completion-ui-tests.json`, {
					success: true,
					numPassedTests: 1,
					numFailedTests: 0,
					testResults: [
						{
							assertionResults: [
								{
									title: "replays the isolated live completion-idle capture through the rendered chat",
									status: "passed",
								},
							],
						},
					],
				})
			}
			attempts.push({
				request,
				result: {
					status: "passed",
					usage: { requests: phases.length * 2, inputTokens: null, outputTokens: null, cost: null },
					actualHostVersion: "1.138.0",
					model: { id: "exact-model", effort: "high" },
					taskIds: [`task-${scenarioIndex}`],
					providerIdentity,
				},
				elapsedMs: 1_000,
				evidence: `${attemptId}/evidence-index.json`,
			})
		}
		const report = {
			version: 1,
			id: config.id,
			mode: "report-only",
			requestedProvider: config.provider,
			startedAt: timestamp,
			finishedAt: timestamp,
			stopReason: "completed",
			evaluationIdentity: { ...current, unchanged: true },
			evaluationPlan: { scenarioIds: config.scenarioIds, hostVersions: ["1.138.0"], samples: 1 },
			counts: { passed: attempts.length, failed: 0, blocked: 0 },
			usage: {
				requests: attempts.reduce((sum, attempt) => sum + attempt.result.usage.requests, 0),
				inputTokens: null,
				outputTokens: null,
				cost: null,
			},
			attempts,
			repairs: [],
			retention: { status: "complete" },
		}
		await write("gate-plan.json", { config, artifactDigest: "3".repeat(64) })
		await write("report-00001.json", report)
		const options = { repositoryRoot: root, evidenceDirectory: root, modelId: "exact-model", effort: "high", now }
		const dependencies = {
			captureIdentity: async () => structuredClone(current),
			captureBuild: async () => structuredClone(build),
		}
		await run({ root, options, dependencies, report, write, current, build })
	} finally {
		const resolved = await realpath(root)
		assert.equal(path.dirname(resolved), await realpath(os.tmpdir()))
		assert.match(path.basename(resolved), /^alpha-ci-live-admission-/)
		await rm(resolved, { recursive: true, force: true })
	}
}

test("imports a fresh source-bound live campaign through actual host and independent outcome validators", async () => {
	await fixture(async ({ options, dependencies, report }) => {
		const receipt = await admitLiveEvidence(options, dependencies)
		assert.equal(receipt.status, "passed")
		assert.equal(receipt.liveRequests, 0)
		assert.equal(receipt.retainedPhases, report.attempts.length + 1)
		assert.equal(receipt.profileSha256.length, 1)
		assert.ok(!JSON.stringify(receipt).includes("owned-profile"))
	})
})

test("rejects symlinked evidence roots before source or build capture", async () => {
	const owned = await realpath(await mkdtemp(path.join(os.tmpdir(), "alpha-ci-live-alias-")))
	const alias = path.join(owned, "temp-alias")
	let linked = false
	try {
		const target = path.join(owned, "physical-temp")
		await mkdir(target)
		await symlink(target, alias, process.platform === "win32" ? "junction" : "dir")
		linked = true
		assert.equal(await realpath(alias), target)
		const receipt = await admitLiveEvidence(
			{ repositoryRoot: owned, evidenceDirectory: alias, modelId: "exact-model", effort: "high", now },
			{
				captureIdentity: async () => assert.fail("No source capture through an evidence symlink"),
				captureBuild: async () => assert.fail("No build capture through an evidence symlink"),
			},
		)
		assert.equal(receipt.status, "blocked")
		assert.equal(receipt.reason, "invalid_live_evidence")
	} finally {
		if (linked) await unlink(alias)
		assert.equal(path.dirname(owned), await realpath(os.tmpdir()))
		assert.match(path.basename(owned), /^alpha-ci-live-alias-/)
		await rm(owned, { recursive: true, force: true })
	}
})

test("missing evidence stays blocked without accessing the source or requesting a provider", async () => {
	const receipt = await admitLiveEvidence(
		{ repositoryRoot: ".", now },
		{ captureIdentity: async () => assert.fail("No source capture without evidence") },
	)
	assert.equal(receipt.status, "blocked")
	assert.equal(receipt.reason, "live_evidence_not_supplied")
})

test("rejects stale reports, another model, changed source/build and a saved passing flag", async () => {
	await fixture(async ({ options, dependencies, current, report, write }) => {
		assert.equal(
			(await admitLiveEvidence({ ...options, now: now + LIVE_EVIDENCE_MAX_AGE_MS }, dependencies)).reason,
			"live_evidence_expired",
		)
		assert.equal(
			(await admitLiveEvidence({ ...options, modelId: "another-model" }, dependencies)).reason,
			"model_policy_mismatch",
		)
		for (const field of [
			"extensionCommit",
			"workingTreeDigest",
			"extensionBuildDigest",
			"harnessDigest",
			"taskSetDigest",
		]) {
			const changed = {
				...dependencies,
				captureIdentity: async () => ({
					...current,
					[field]: "0".repeat(field === "extensionCommit" ? 40 : 64),
				}),
			}
			assert.equal((await admitLiveEvidence(options, changed)).reason, "source_or_build_mismatch", field)
		}
		await write("gate-result.json", { status: "passed", artifactsUnchanged: true })
		report.attempts[0].result.status = "failed"
		await write("report-00002.json", report)
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "live_acceptance_failed")
	})
})

test("rejects transferred artifacts with missing phases, changed bytes, skipped tests or no observed host exit", async () => {
	await fixture(async ({ root, options, dependencies, report, write }) => {
		const indexPath = report.attempts[0].evidence
		const index = JSON.parse(await readFile(path.join(root, indexPath), "utf8"))
		await write(indexPath, { ...index, manifests: ["../elsewhere/manifest.json"] })
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "phase_capture_mismatch")
		await write(indexPath, index)
		const directory = path.dirname(index.manifests[0])
		const runnerPath = `${directory}/run-result.json`
		const runner = JSON.parse(await readFile(path.join(root, runnerPath), "utf8"))
		await write(runnerPath, { ...runner, testCounts: { total: 1, passed: 0, pending: 1, failed: 0, executed: 0 } })
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "invalid_host_execution")
		await write(runnerPath, { ...runner, hostExitObserved: false })
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "invalid_host_execution")
		await write(runnerPath, runner)
		await write(`${directory}/task-summary.json`, { changed: true })
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "artifact_checksum_mismatch")
	})
})

test("explicitly unverified host cleanup blocks live evidence admission", async () => {
	await fixture(async ({ root, options, dependencies, report, write }) => {
		const index = JSON.parse(await readFile(path.join(root, report.attempts[0].evidence), "utf8"))
		const runnerPath = `${path.dirname(index.manifests[0])}/run-result.json`
		const runner = JSON.parse(await readFile(path.join(root, runnerPath), "utf8"))
		await write(runnerPath, { ...runner, hostCleanupVerified: false })
		const rejected = await admitLiveEvidence(options, dependencies)
		assert.equal(rejected.status, "blocked")
		assert.equal(rejected.reason, "invalid_host_execution")
		await write(runnerPath, { ...runner, hostCleanupVerified: true })
		assert.equal((await admitLiveEvidence(options, dependencies)).status, "passed")
		await write(runnerPath, runner)
		assert.equal((await admitLiveEvidence(options, dependencies)).status, "passed")
	})
})

test("rejects contradictory independent outcomes, wrong provider bytes and incomplete retention", async () => {
	await fixture(async ({ root, options, dependencies, report, write }) => {
		const index = JSON.parse(await readFile(path.join(root, report.attempts[0].evidence), "utf8"))
		const directory = path.dirname(index.manifests[0])
		const workflowPath = `${directory}/workflow-result.json`
		const workflow = JSON.parse(await readFile(path.join(root, workflowPath), "utf8"))
		await write(workflowPath, { ...workflow, checks: [{ name: "workspace-outcome", passed: false }] })
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "independent_outcome_failed")
		await write(workflowPath, workflow)
		const runnerPath = `${directory}/run-result.json`
		const runner = JSON.parse(await readFile(path.join(root, runnerPath), "utf8"))
		await write(runnerPath, { ...runner, providerIdentity: { ...runner.providerIdentity, status: "unknown" } })
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "invalid_host_execution")
		await write(runnerPath, runner)
		await write(`${directory}/retention-result.json`, { status: "complete" })
		assert.equal((await admitLiveEvidence(options, dependencies)).status, "blocked")
	})
})

test("valid artifact hashes cannot substitute for captured task journals or a coherent evidence join", async () => {
	await fixture(async ({ root, options, dependencies, report, write }) => {
		const index = JSON.parse(await readFile(path.join(root, report.attempts[0].evidence), "utf8"))
		const manifestPath = index.manifests[0]
		const manifest = JSON.parse(await readFile(path.join(root, manifestPath), "utf8"))
		manifest.taskEvidence[0].status = "absent"
		await write(manifestPath, manifest)
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "task_capture_missing")
		manifest.taskEvidence[0].status = "captured"
		const artifact = manifest.artifacts.find((entry) =>
			entry.path.endsWith("agent_lifecycle_events.jsonl.projection.json"),
		)
		const artifactPath = `${path.dirname(manifestPath)}/${artifact.path}`
		const journal = JSON.parse(await readFile(path.join(root, artifactPath), "utf8"))
		const originalJournal = structuredClone(journal)
		journal.projection.events = []
		await write(artifactPath, journal)
		const rewritten = await readFile(path.join(root, artifactPath))
		artifact.bytes = rewritten.length
		artifact.sha256 = hash(rewritten)
		await write(manifestPath, manifest)
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "invalid_task_projection")
		await write(artifactPath, originalJournal)
		const restored = await readFile(path.join(root, artifactPath))
		artifact.bytes = restored.length
		artifact.sha256 = hash(restored)
		const joinArtifact = manifest.artifacts.find((entry) => entry.path.endsWith("-evidence-join.json"))
		const joinPath = `${path.dirname(manifestPath)}/${joinArtifact.path}`
		await write(joinPath, { status: "captured", records: [] })
		const joined = await readFile(path.join(root, joinPath))
		joinArtifact.bytes = joined.length
		joinArtifact.sha256 = hash(joined)
		await write(manifestPath, manifest)
		assert.equal((await admitLiveEvidence(options, dependencies)).reason, "invalid_task_evidence_join")
	})
})

test("a refreshed report cannot make old host captures fresh, and admission rejects concurrent source drift", async () => {
	await fixture(async ({ root, options, dependencies, report, current, write }) => {
		let captures = 0
		const changed = {
			...dependencies,
			captureIdentity: async () => ({
				...current,
				workingTreeDigest: ++captures === 1 ? current.workingTreeDigest : "0".repeat(64),
			}),
		}
		assert.equal((await admitLiveEvidence(options, changed)).reason, "source_or_build_changed_during_admission")
		const index = JSON.parse(await readFile(path.join(root, report.attempts[0].evidence), "utf8"))
		const manifestPath = index.manifests[0]
		const manifest = JSON.parse(await readFile(path.join(root, manifestPath), "utf8"))
		manifest.metadata.startedAt = new Date(now - LIVE_EVIDENCE_MAX_AGE_MS - 10_000).toISOString()
		manifest.metadata.finishedAt = manifest.metadata.startedAt
		report.startedAt = manifest.metadata.startedAt
		await write(manifestPath, manifest)
		await write("report-00002.json", report)
		assert.equal(
			(await admitLiveEvidence(options, dependencies)).reason,
			"host_capture_expired_or_outside_campaign",
		)
	})
})

test("conversation capture validates pairing without imposing a tool-use requirement on live outcomes", async () => {
	await fixture(async ({ root, options, dependencies, report, write }) => {
		const index = JSON.parse(await readFile(path.join(root, report.attempts[0].evidence), "utf8"))
		const manifestPath = index.manifests[0]
		const manifest = JSON.parse(await readFile(path.join(root, manifestPath), "utf8"))
		const artifact = manifest.artifacts.find((entry) =>
			entry.path.endsWith("api_conversation_history.json.projection.json"),
		)
		const artifactPath = `${path.dirname(manifestPath)}/${artifact.path}`
		const conversation = JSON.parse(await readFile(path.join(root, artifactPath), "utf8"))
		conversation.projection = [{ role: "assistant", tools: [] }]
		await write(artifactPath, conversation)
		const bytes = await readFile(path.join(root, artifactPath))
		artifact.bytes = bytes.length
		artifact.sha256 = hash(bytes)
		await write(manifestPath, manifest)
		assert.equal((await admitLiveEvidence(options, dependencies)).status, "passed")
	})
})
