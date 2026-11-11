import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createRequire } from "node:module"
import test from "node:test"
import {
	collectReleaseQualityPolicy,
	evidenceWorkflow,
	releaseQualityCli,
	releaseQualityRequired,
	validateEvidenceRun,
	validateLiveSmokeEvidence,
} from "./release-quality.mjs"

test("release promotion revalidates one reviewed live smoke while retaining full deterministic gates", async () => {
	const require = createRequire(import.meta.url)
	const yaml = createRequire(require.resolve("eslint/package.json"))("js-yaml")
	const workflow = yaml.load(
		await fs.readFile(new URL("../../.github/workflows/release-vsix.yml", import.meta.url), "utf8"),
	)
	const jobs = workflow.jobs
	assert.equal(jobs.validation.needs, "live-quality")
	assert.equal(jobs["package-vsix"].needs, "live-quality")
	assert.deepEqual(jobs["publish-release"].needs, ["live-quality", "validation", "package-vsix", "release-gate"])
	assert.equal(jobs["live-quality"].permissions.actions, "read")
	const steps = jobs["live-quality"].steps
	const verification = steps.find((step) => step.run?.includes("release-quality.mjs verify-run"))
	assert.equal(verification.if, "steps.policy.outputs.required != 'false'")
	// Missing policy output must enter validation and fail, never silently skip it.
	for (const step of steps.filter((step) => step.if?.includes("steps.policy.outputs.required")))
		assert.equal(step.if, "steps.policy.outputs.required != 'false'")
	assert.match(verification.run, /--run-id "\$QUALITY_EVIDENCE_RUN_ID" --candidate "\$GITHUB_SHA"/u)
	const download = steps.find((step) => step.uses?.startsWith("actions/download-artifact@"))
	assert.equal(download.with.name, "live-quality-evidence-${{ github.sha }}")
	assert.equal(download.with["run-id"], "${{ inputs.quality_evidence_run_id }}")
	const smoke = steps.find((step) => step.run?.includes("release-quality.mjs verify-smoke"))
	assert.match(smoke.run, /--candidate "\$GITHUB_SHA"/u)
	assert.match(smoke.run, /--input .*bundle.json/u)
	assert.doesNotMatch(JSON.stringify(steps), /--live-quality-bundle|--require-baseline-commit/u)
	for (const lane of [
		"static",
		"turns",
		"unit",
		"tooling",
		"offline",
		"host",
		"extended",
		"confidence",
		"rendered",
		"stress",
		"outcomes",
	])
		assert.ok(
			jobs.validation.strategy.matrix.include.some((entry) => entry.lane === lane),
			lane,
		)
	const evidence = yaml.load(
		await fs.readFile(new URL("../../.github/workflows/live-quality-evidence.yml", import.meta.url), "utf8"),
	)
	assert.ok(evidence.jobs.validate.steps.some((step) => step.run?.includes("release-quality.mjs verify-smoke")))
	assert.doesNotMatch(JSON.stringify(evidence), /--live-quality-bundle|--require-baseline-commit/u)
})

async function fixture(t, tagged = true) {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-release-quality-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const git = (...args) =>
		execFileSync("git", ["-c", "core.hooksPath=disabled", "-c", "commit.gpgsign=false", ...args], {
			cwd: root,
			encoding: "utf8",
			windowsHide: true,
		}).trim()
	git("init", "-q", "--initial-branch=main")
	git("config", "user.name", "Quality fixture")
	git("config", "user.email", "fixture@example.invalid")
	git("config", "core.autocrlf", "false")
	const commit = async (file) => {
		await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true })
		await fs.writeFile(path.join(root, file), "fixture\n")
		git("add", "--", file)
		git("commit", "-q", "-m", "fixture")
		return git("rev-parse", "HEAD")
	}
	const baseline = await commit("README.md")
	if (tagged) git("tag", "vsix-v1.0.0", baseline)
	return { root, git, commit, baseline }
}

test("release policy compares the full range to an ancestral publication, excluding unrelated and candidate tags", async (t) => {
	const { root, git, commit, baseline } = await fixture(t)
	git("switch", "-q", "-c", "unrelated")
	await commit("side.txt")
	git("tag", "vsix-v99.0.0")
	git("switch", "-q", "main")
	await commit("src/core/agent/Turn.ts")
	const candidate = await commit("docs/notes.md")
	git("tag", "vsix-v2.0.0", candidate)
	assert.deepEqual(await collectReleaseQualityPolicy(root, candidate), { required: true, baseline, candidate })
})

test("documentation-only releases still identify the baseline and write only fixed GitHub output keys", async (t) => {
	const { root, commit, baseline } = await fixture(t)
	const candidate = await commit("docs/notes.md")
	const output = path.join(root, "outputs")
	assert.deepEqual(
		await releaseQualityCli(["policy", "--candidate", candidate], { root, env: { GITHUB_OUTPUT: output } }),
		{ required: false, baseline, candidate },
	)
	assert.equal(await fs.readFile(output, "utf8"), `required=false\nbaseline=${baseline}\ncandidate=${candidate}\n`)
})

test("release policy fails closed without a published ancestor, a parent, or an exact existing SHA", async (t) => {
	const { root, commit, baseline } = await fixture(t, false)
	const candidate = await commit("src/api/provider.ts")
	for (const value of [baseline, candidate, "a".repeat(40), "HEAD", `${candidate}\nrequired=false`])
		await assert.rejects(collectReleaseQualityPolicy(root, value), /release candidate SHA|ancestral published/u)
})

test("harness and measurement owners require quality evidence while unrelated UI/docs do not", () => {
	for (const file of [
		"src/core/agent/a.ts",
		"src/core/task/Task.ts",
		"src/core/tools/a.ts",
		"src/core/prompts/a.ts",
		"src/core/context-management/a.ts",
		"src/core/condense/a.ts",
		"src/core/task-persistence/a.ts",
		"src/core/auto-approval/a.ts",
		"src/core/webview/AlphaProvider.ts",
		"src/shared/modes.ts",
		"packages/types/src/global-settings.ts",
		"apps/vscode-e2e/src/scenarios/requestBudget.ts",
		"src/api/providers/a.ts",
		"src/integrations/terminal/a.ts",
		"src/shared/tools.ts",
		"packages/types/src/agent-control.ts",
		"packages/types/src/subagent.ts",
		"packages/types/src/task.ts",
		"packages/types/src/provider-settings.ts",
		"packages/types/src/providers/vscode-llm.ts",
		"packages/types/src/__tests__/agent-response.test.ts",
		"apps/vscode-e2e/src/quality/liveQuality.ts",
		"apps/vscode-e2e/src/runQuality.ts",
		"apps/vscode-e2e/src/suite/live-quality.test.ts",
		"scripts/evals/proportional-scope-compare.mjs",
		"scripts/evals/proportional-scope-report.mjs",
		"evals/proportional-scope/cases.json",
		"scripts/harness/release-quality.mjs",
		"scripts/harness/release-evidence.mjs",
		evidenceWorkflow,
		".github/workflows/release-vsix.yml",
	])
		assert.equal(releaseQualityRequired([file]), true, file)
	assert.equal(
		releaseQualityRequired(["README.md", "webview-ui/src/components/Button.tsx", "src/core/taskish/a.ts"]),
		false,
	)
})

const candidate = "a".repeat(40)
const repository = "example/Alpha"
const run = {
	id: 123,
	status: "completed",
	conclusion: "success",
	event: "workflow_dispatch",
	path: evidenceWorkflow,
	head_sha: candidate,
	repository: { full_name: repository },
	head_repository: { full_name: repository },
}

test("evidence provenance accepts only the successful manual candidate workflow from the own repository", () => {
	assert.deepEqual(validateEvidenceRun(run, { candidate, repository, runId: "123" }), {
		runId: "123",
		candidate,
		repository,
		workflow: evidenceWorkflow,
	})
	assert.equal(validateEvidenceRun(run, { candidate, repository: repository.toLowerCase() }).candidate, candidate)
	for (const patch of [
		{ status: "in_progress" },
		{ conclusion: "failure" },
		{ event: "pull_request" },
		{ path: ".github/workflows/other.yml" },
		{ head_sha: "b".repeat(40) },
		{ repository: { full_name: "other/Alpha" } },
		{ head_repository: { full_name: "fork/Alpha" } },
		{ head_repository: null },
		{ id: 124 },
		{ id: "123" },
	])
		assert.throws(
			() => validateEvidenceRun({ ...run, ...patch }, { candidate, repository, runId: "123" }),
			/successful own-repository/u,
		)
	assert.throws(() => validateEvidenceRun(null, { candidate, repository }), /successful own-repository/u)
})

const smoke = {
	schemaVersion: 1,
	kind: "alpha-live-extension-smoke",
	reviewedForCandidate: candidate,
	reuseRecorded: false,
	runId: "luna-smoke",
	fixtureId: "supported-total",
	capturedAt: "2026-11-04T12:00:00.000Z",
	hostVersion: "1.141.0",
	providerMode: "live-copilot",
	provider: "live-copilot",
	modelId: "gpt-6-luna",
	effort: "max",
	status: "passed",
	execution: "extension-host",
	exitCode: 0,
	completed: 1,
	modelCalls: 2,
	durationMs: 1000,
	hostExitObserved: true,
	ownershipGate: "verified",
	captureComplete: true,
	observedSourceRevision: null,
	artifactBinding: "manifest-inventory",
	evidence: { run: "a".repeat(64), task: "b".repeat(64), manifest: "c".repeat(64) },
}

test("one successful Luna extension task satisfies release smoke without a baseline or other models", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-release-smoke-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const input = path.join(root, "input.json")
	const output = path.join(root, "smoke.json")
	await fs.writeFile(input, JSON.stringify(smoke))
	const result = await releaseQualityCli([
		"verify-smoke",
		"--candidate",
		candidate,
		"--input",
		input,
		"--output",
		output,
	])
	assert.equal(result.status, "passed")
	assert.equal(JSON.parse(await fs.readFile(output, "utf8")).modelId, "gpt-6-luna")
})

test("a reviewed recorded Luna pass keeps its original host, date and unknown source identity", () => {
	const recorded = { ...smoke, hostVersion: "1.139.1", capturedAt: "2026-09-28T03:34:59.180Z" }
	assert.throws(() => validateLiveSmokeEvidence(recorded, { candidate }), /explicit reuse review/u)
	const result = validateLiveSmokeEvidence(
		{ ...recorded, reuseRecorded: true, rawPrompt: "private-input" },
		{ candidate },
	)
	assert.equal(result.hostVersion, "1.139.1")
	assert.equal(result.capturedAt, recorded.capturedAt)
	assert.equal(result.observedSourceRevision, null)
	assert.equal(result.reviewedForCandidate, candidate)
	assert.doesNotMatch(JSON.stringify(result), /private-input|rawPrompt/u)
})

for (const patch of [
	{ reviewedForCandidate: "b".repeat(40) },
	{ status: "blocked" },
	{ providerMode: "scripted" },
	{ provider: "vscode-lm-fixture" },
	{ modelId: "" },
	{ hostVersion: "1.124.0", reuseRecorded: true },
	{ execution: "cli" },
	{ exitCode: 1 },
	{ completed: 0 },
	{ modelCalls: 0 },
	{ durationMs: 0 },
	{ hostExitObserved: false },
	{ ownershipGate: "unverified" },
	{ captureComplete: false },
	{ observedSourceRevision: "unknown" },
	{ artifactBinding: "recorded-legacy" },
	{ evidence: {} },
])
	test(`live smoke refuses unavailable or mismatched facts: ${JSON.stringify(patch)}`, () => {
		assert.throws(
			() => validateLiveSmokeEvidence({ ...smoke, ...patch }, { candidate }),
			/Live smoke|successful captured/u,
		)
	})

test("smoke export binds existing host artifacts, strips task contents and rejects changed task bytes", async (t) => {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-smoke-export-"))
	t.after(() => fs.rm(root, { recursive: true, force: true }))
	const task = {
		passed: true,
		completed: 1,
		requests: 2,
		elapsedMs: 1000,
		hostVersion: smoke.hostVersion,
		provider: "vscode-lm",
		providerMode: smoke.providerMode,
		model: { id: smoke.modelId, vendor: "copilot" },
		effort: smoke.effort,
		rawPrompt: "private-task-content",
	}
	const taskBytes = JSON.stringify(task)
	await fs.writeFile(path.join(root, "supported-total.json"), taskBytes)
	const primaryPath = path.join(root, "run-result.json")
	const retentionPath = path.join(root, "retention-result.json")
	const inactivePath = path.join(root, ".retention-eligible.json")
	const primary = { ...smoke, actualVSCodeVersion: smoke.hostVersion, providerIdentity: { status: "unchanged" } }
	const retention = { schemaVersion: 1, runId: smoke.runId, status: "complete", eligibility: "pending-release" }
	const inactive = { kind: "alpha-vscode-e2e-inactive", version: 1, runId: smoke.runId }
	const retainedPrimary = { ...primary, retentionResultPath: retentionPath }
	await fs.writeFile(primaryPath, JSON.stringify(retainedPrimary))
	await fs.writeFile(retentionPath, JSON.stringify(retention))
	await fs.writeFile(inactivePath, JSON.stringify(inactive))
	await fs.writeFile(
		path.join(root, "manifest.json"),
		JSON.stringify({
			kind: "alpha-vscode-e2e-run-evidence",
			runId: smoke.runId,
			finalized: true,
			captureComplete: true,
			metadata: {
				outcome: "passed",
				provider: smoke.providerMode,
				hostVersion: smoke.hostVersion,
				modelId: smoke.modelId,
				reasoningEffort: smoke.effort,
				finishedAt: smoke.capturedAt,
			},
			artifacts: [{ path: "supported-total.json", sha256: createHash("sha256").update(taskBytes).digest("hex") }],
		}),
	)
	const output = path.join(root, "smoke.json")
	const dispatch = path.join(root, "dispatch.json")
	const args = ["verify-smoke", "--candidate", candidate, "--run-dir", root, "--fixture", "supported-total"]
	const result = await releaseQualityCli([...args, "--output", output, "--dispatch-input", dispatch])
	assert.equal(result.provider, "live-copilot")
	assert.equal(result.artifactBinding, "manifest-inventory")
	assert.doesNotMatch(await fs.readFile(dispatch, "utf8"), /private-task-content|rawPrompt/u)
	assert.deepEqual(JSON.parse(JSON.parse(await fs.readFile(dispatch, "utf8")).reports), result)
	await t.test("requires a stable Copilot provider identity for a VS Code model receipt", async () => {
		await fs.writeFile(primaryPath, JSON.stringify({ ...retainedPrimary, providerIdentity: { status: "changed" } }))
		try {
			await assert.rejects(
				releaseQualityCli([...args, "--output", path.join(root, "changed-provider.json")]),
				/host, provider, model, time and artifact identities/u,
			)
		} finally {
			await fs.writeFile(primaryPath, JSON.stringify(retainedPrimary))
		}
	})
	await t.test("refuses a passing primary when retention is blocked or failed", async () => {
		for (const status of ["blocked", "failed"]) {
			await fs.writeFile(retentionPath, JSON.stringify({ ...retention, status }))
			await assert.rejects(
				releaseQualityCli([...args, "--output", path.join(root, `${status}.json`)]),
				/retention/u,
			)
		}
	})
	await t.test("refuses a retention error after a complete report", async () => {
		await fs.writeFile(retentionPath, JSON.stringify(retention))
		const failure = path.join(root, "retention-error.json")
		await fs.writeFile(failure, JSON.stringify({ schemaVersion: 1, runId: smoke.runId, status: "failed" }))
		try {
			await assert.rejects(
				releaseQualityCli([...args, "--reuse-recorded", "true", "--output", path.join(root, "failure.json")]),
				/retention/u,
			)
		} finally {
			await fs.unlink(failure)
		}
	})
	await t.test("requires matching retention and the completed release marker for a standalone run", async () => {
		await fs.writeFile(retentionPath, JSON.stringify({ ...retention, runId: "other-run" }))
		await assert.rejects(releaseQualityCli([...args, "--output", path.join(root, "wrong-run.json")]), /retention/u)
		await fs.writeFile(retentionPath, JSON.stringify(retention))
		await fs.unlink(inactivePath)
		await assert.rejects(
			releaseQualityCli([...args, "--output", path.join(root, "no-release-marker.json")]),
			/retention/u,
		)
	})
	await t.test("allows absent retention only for explicitly reused historical captures", async () => {
		await fs.unlink(retentionPath)
		await assert.rejects(
			releaseQualityCli([...args, "--reuse-recorded", "true", "--output", path.join(root, "incomplete.json")]),
			/retention/u,
		)
		await fs.writeFile(primaryPath, JSON.stringify(primary))
		await assert.rejects(releaseQualityCli([...args, "--output", path.join(root, "unreviewed.json")]), /retention/u)
		const reused = await releaseQualityCli([
			...args,
			"--reuse-recorded",
			"true",
			"--output",
			path.join(root, "reused.json"),
		])
		assert.equal(reused.reuseRecorded, true)
		assert.equal(reused.observedSourceRevision, null)
	})
	await fs.writeFile(path.join(root, "supported-total.json"), JSON.stringify({ ...task, passed: false }))
	await assert.rejects(
		releaseQualityCli([...args, "--reuse-recorded", "true", "--output", path.join(root, "invalid.json")]),
		/artifacts do not match/u,
	)
	await assert.rejects(fs.stat(path.join(root, "invalid.json")), { code: "ENOENT" })
	await assert.rejects(
		releaseQualityCli([
			"verify-smoke",
			"--candidate",
			candidate,
			"--run-dir",
			root,
			"--fixture",
			"../outside",
			"--output",
			output,
		]),
		/fixture identifier/u,
	)
})

test("invalid CLI inputs fail before a metadata command can execute", async () => {
	for (const args of [
		["verify-run", "--candidate", candidate, "--run-id", "1;echo secret"],
		["verify-run", "--candidate", "HEAD", "--run-id", "123"],
		["policy", "--candidate", candidate, "--candidate", candidate],
		["verify-run", "--candidate", candidate, "--run-id", "123"],
	])
		await assert.rejects(releaseQualityCli(args, { env: { GITHUB_REPOSITORY: "../other/repo" } }))
})
