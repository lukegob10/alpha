import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { OutcomeProofError, outcomeProofVerdict, readOutcomeProofs } from "./outcome-proof.mjs"
import { proofFixture } from "./fixtures/outcome-proof.mjs"
import { require as tsRequire } from "tsx/cjs/api"

const { joinProjectedEvidence } = tsRequire("../../apps/vscode-e2e/src/evidence/journalProjection.ts", import.meta.url)

const verdict = (fixture) => outcomeProofVerdict(fixture.proofs, fixture.campaign, fixture.receipts, fixture.build)
test("capture completeness never substitutes for exact task and independent workflow evidence", () => {
	assert.equal(verdict(proofFixture()).status, "passed")
	for (const mutate of [
		(value) => (value.proofs[0].manifest.metadata.scenarioId = "unrelated-scenario"),
		(value) => (value.proofs[0].manifest.metadata.hostVersion = "9.9.9"),
		(value) => (value.proofs[0].manifest.metadata.provider = "live-copilot"),
		(value) => (value.proofs[0].manifest.metadata.outcome = "failed"),
		(value) => (value.proofs[0].manifest.metadata.taskIds = []),
		(value) => (value.proofs[0].manifest.taskEvidence = []),
		(value) => delete value.proofs[0].manifest.bundleSha256,
		(value) => (value.proofs[0].manifest.metadata.finishedAt = "invalid"),
		(value) => value.proofs[0].manifest.warnings.push("TASK_EVIDENCE_INCOMPLETE"),
		(value) => value.proofs[0].artifacts.pop(),
		(value) => (value.proofs[0].workflow.value.checks[0].passed = false),
		(value) => (value.proofs[0].workflow.value.taskIds = ["another-task"]),
		(value) => (value.campaign.evaluationIdentity.extensionBuildDigest = "b".repeat(64)),
	]) {
		const fixture = proofFixture()
		mutate(fixture)
		assert.equal(verdict(fixture).status, "failed")
	}
})

test("rehashed wrong task projections, terminal failures, missing API receipts and forged joins fail admission", () => {
	for (const mutate of [
		(value) => (value.proofs[0].artifacts[2].value.projection.events[0].taskIdSha256 = "b".repeat(64)),
		(value) => (value.proofs[0].artifacts[2].value.projection.events[0].status = "failed"),
		(value) => value.proofs[0].artifacts[4].value.projection.pop(),
		(value) => (value.proofs[0].artifacts[5].value.records = []),
	]) {
		const fixture = proofFixture()
		mutate(fixture)
		for (const artifact of fixture.proofs[0].artifacts) {
			const bytes = Buffer.from(JSON.stringify(artifact.value, null, 2))
			artifact.bytes = bytes.length
			artifact.sha256 = createHash("sha256").update(bytes).digest("hex")
			Object.assign(
				fixture.proofs[0].manifest.artifacts.find((declared) => declared.path === artifact.path),
				{ bytes: artifact.bytes, sha256: artifact.sha256 },
			)
		}
		assert.equal(verdict(fixture).status, "failed")
	}
})

test("legacy optional identity fields and additive events without a turn remain comparable", () => {
	const fixture = proofFixture()
	const proof = fixture.proofs[0]
	const lifecycle = proof.artifacts[2].value.projection.events
	const events = proof.artifacts[3].value.projection.events
	events.push({
		type: "task_completed",
		taskIdSha256: events[0].taskIdSha256,
		runIdSha256: events[0].runIdSha256,
		sequence: 2,
		status: "completed",
	})
	proof.artifacts[5].value = JSON.parse(
		JSON.stringify({
			status: "captured",
			validation: { lifecycle: "validated", eventLog: "validated" },
			...joinProjectedEvidence({ lifecycle, eventLog: events }),
		}),
	)
	for (const artifact of proof.artifacts) {
		const bytes = Buffer.from(JSON.stringify(artifact.value, null, 2))
		artifact.bytes = bytes.length
		artifact.sha256 = createHash("sha256").update(bytes).digest("hex")
		Object.assign(
			proof.manifest.artifacts.find((declared) => declared.path === artifact.path),
			{ bytes: artifact.bytes, sha256: artifact.sha256 },
		)
	}
	assert.equal(verdict(fixture).status, "passed")
})

test("real bounded owner files are joined, and a failed complete capture is rejected before saving a proof", async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-outcome-proof-"))
	try {
		const fixture = proofFixture()
		for (const [index, proof] of fixture.proofs.entries()) {
			const runDirectory = path.join(directory, "host-evidence", proof.runId)
			await mkdir(runDirectory, { recursive: true })
			await mkdir(path.join(directory, fixture.campaign.attempts[index].request.attemptId))
			await writeFile(
				path.join(directory, fixture.campaign.attempts[index].evidence),
				JSON.stringify({ schemaVersion: 1, manifests: [`host-evidence/${proof.runId}/manifest.json`] }),
			)
			await writeFile(path.join(runDirectory, "manifest.json"), JSON.stringify(proof.manifest))
			await writeFile(
				path.join(runDirectory, "workflow-result.json"),
				JSON.stringify(proof.workflow.value, null, 2) + "\n",
			)
			for (const artifact of proof.artifacts)
				await writeFile(path.join(runDirectory, artifact.path), JSON.stringify(artifact.value, null, 2))
		}
		const proofs = await readOutcomeProofs(directory, fixture.campaign, fixture.receipts, fixture.build)
		assert.equal(verdict({ ...fixture, proofs }).status, "passed")
		const manifest = fixture.proofs[0].manifest
		manifest.metadata = {
			...manifest.metadata,
			scenarioId: "unrelated-scenario",
			hostVersion: "9.9.9",
			provider: "live-copilot",
			outcome: "failed",
			taskIds: [],
		}
		await writeFile(
			path.join(directory, "host-evidence", fixture.proofs[0].runId, "manifest.json"),
			JSON.stringify(manifest),
		)
		await assert.rejects(
			readOutcomeProofs(directory, fixture.campaign, fixture.receipts, fixture.build),
			(error) => error instanceof OutcomeProofError && error.reason === "invalid_outcome_capture_binding",
		)
	} finally {
		await rm(directory, { recursive: true, force: true })
	}
})

test("stripped and rehashed scenario assertions cannot establish independent task outcomes", () => {
	const generic = new Set([
		"tool_transactions_complete",
		"actual_tool_calls_present",
		"all_calls_have_receipts",
		"required_turns_completed",
		"no_unexpected_failed_turn",
	])
	const rehash = (workflow) => {
		const bytes = Buffer.from(JSON.stringify(workflow.value, null, 2) + "\n")
		workflow.bytes = bytes.length
		workflow.sha256 = createHash("sha256").update(bytes).digest("hex")
	}
	for (const [index, original] of proofFixture().proofs.entries()) {
		const independent = original.workflow.value.checks.filter((check) => !generic.has(check.name))
		assert.ok(independent.length > 0)
		for (const missing of [undefined, ...independent.map((check) => check.name)]) {
			const fixture = proofFixture()
			const workflow = fixture.proofs[index].workflow
			workflow.value.checks = workflow.value.checks.filter((check) =>
				missing === undefined ? generic.has(check.name) : check.name !== missing,
			)
			rehash(workflow)
			assert.deepEqual(verdict(fixture), { status: "failed", reason: "missing_independent_workflow_checks" })
		}
	}
})
