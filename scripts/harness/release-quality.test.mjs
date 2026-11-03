import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
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
} from "./release-quality.mjs"

test("release promotion depends on revalidated live evidence for the exact revisions", async () => {
	const require = createRequire(import.meta.url)
	const yaml = createRequire(require.resolve("eslint/package.json"))("js-yaml")
	const workflow = yaml.load(
		await fs.readFile(new URL("../../.github/workflows/release-vsix.yml", import.meta.url), "utf8"),
	)
	const jobs = workflow.jobs
	assert.equal(jobs["release-vsix"].needs, "live-quality")
	assert.ok(jobs["package-vsix"].needs.includes("live-quality"))
	assert.ok(jobs["package-vsix"].needs.includes("release-vsix"))
	assert.equal(jobs["publish-release"].needs, "package-vsix")
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
	const comparison = steps.find((step) => step.run?.includes("--live-quality-bundle"))
	assert.match(comparison.run, /--require-baseline-commit "\$QUALITY_BASELINE"/u)
	assert.match(comparison.run, /--require-candidate-commit "\$GITHUB_SHA"/u)
	assert.equal(comparison.env.QUALITY_BASELINE, "${{ steps.policy.outputs.baseline }}")
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

test("invalid CLI inputs fail before a metadata command can execute", async () => {
	for (const args of [
		["verify-run", "--candidate", candidate, "--run-id", "1;echo secret"],
		["verify-run", "--candidate", "HEAD", "--run-id", "123"],
		["policy", "--candidate", candidate, "--candidate", candidate],
		["verify-run", "--candidate", candidate, "--run-id", "123"],
	])
		await assert.rejects(releaseQualityCli(args, { env: { GITHUB_REPOSITORY: "../other/repo" } }))
})
