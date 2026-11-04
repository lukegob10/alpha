import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"
import { lanes } from "./catalog.mjs"
import { hostReceipt } from "./fixtures/evidence.mjs"
import { proofFixture } from "./fixtures/outcome-proof.mjs"
import { hostSuites, hostSuiteVerdict, outcomeCampaignVerdict } from "./host-evidence.mjs"
import { laneExpectedInventories } from "./lane-evidence.mjs"
import {
	aggregateReleaseEvidence,
	releaseEvidenceCli,
	releaseTargets,
	releaseValidationPlatforms,
	requireReleaseNeeds,
	validateJobContext,
	validatePackageEvidence,
	validateValidationEvidence,
} from "./release-evidence.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const now = Date.parse("2026-10-02T11:00:00.000Z")
const hash = "a".repeat(64)
const source = { commit: "a".repeat(40), dirty: false, treeSha256: hash, lockfileSha256: hash }
const expected = {
	source,
	gitTree: "b".repeat(40),
	node: "24.21.0",
	pnpm: "11.24.0",
	platform: "linux",
	arch: "x64",
	createdAt: "2026-10-02T10:02:00.000Z",
	ci: { runId: "123", runAttempt: "1", job: "release-gate" },
}
const needs = Object.fromEntries(
	["live-quality", "validation", "package-vsix"].map((job) => [job, { result: "success" }]),
)
const context = (role, platform = "linux", arch = "x64") => ({
	...structuredClone(expected),
	platform,
	arch,
	ci: { ...expected.ci, job: role },
})
const counts = (total) => ({ total, passed: total, failed: 0, skipped: 0, todo: 0, cancelled: 0 })

function execution(files, runner) {
	return {
		schemaVersion: 1,
		kind: "alpha-test-execution",
		runner,
		complete: true,
		success: true,
		counts: counts(files.length),
		files: files.map((file) => ({ path: file, counts: counts(1) })),
	}
}

async function validation(lane) {
	const definition = lanes[lane]
	const report = {
		schemaVersion: 2,
		id: `release-${lane}`,
		lane,
		filters: [],
		status: "passed",
		startedAt: "2026-10-02T10:00:00.000Z",
		finishedAt: "2026-10-02T10:01:00.000Z",
		node: expected.node,
		pnpm: expected.pnpm,
		source,
		sourceAtEnd: source,
		sourceUnchangedAtBoundaries: true,
		steps: definition.commands.map((baseArgs) => ({
			baseArgs,
			startedAt: "2026-10-02T10:00:00.000Z",
			finishedAt: "2026-10-02T10:01:00.000Z",
			status: "passed",
			exitCode: 0,
			signal: null,
			evidence: { status: "passed", kind: lane === "static" ? "mechanical-command" : "command-only" },
		})),
	}
	const inventories = await laneExpectedInventories(root, definition, lane)
	let outcomeBuild
	for (const [index, descriptor] of (definition.receipts ?? []).entries()) {
		if (!descriptor) continue
		if (["node", "vitest"].includes(descriptor.runner))
			report.steps[index].evidence = {
				status: "passed",
				receipt: execution(inventories[index], descriptor.runner),
			}
		else if (descriptor.runner === "extension-host") {
			const receipts = hostSuites[descriptor.suite].map((file) => ({
				...hostReceipt(file),
				...(descriptor.suite === "minimum"
					? { requestedHostVersion: "1.125.0", actualHostVersion: "1.125.0" }
					: {}),
			}))
			report.steps[index].evidence = hostSuiteVerdict(receipts, descriptor.suite)
		} else {
			const fixture = proofFixture(report.id)
			outcomeBuild = fixture.build
			report.steps[index].evidence = {
				...outcomeCampaignVerdict(fixture.campaign, fixture.receipts, report.id),
				proofs: fixture.proofs,
				build: fixture.build,
			}
		}
	}
	return {
		schemaVersion: 1,
		kind: "alpha-release-validation",
		lane,
		context: context("validation", releaseValidationPlatforms[lane]),
		report,
		...(outcomeBuild ? { outcomeBuild } : {}),
	}
}

let allValidation
const validationFixtures = () =>
	(allValidation ??= Promise.all(Object.keys(releaseValidationPlatforms).map(validation)))

async function packages(directory) {
	return Promise.all(
		releaseTargets.map(async (target) => {
			const bytes = Buffer.from(`package fixture ${target}`)
			const file = `alpha-3.2.22-${target}.vsix`
			await writeFile(path.join(directory, file), bytes)
			const [platform, arch] = target.split("-")
			return {
				schemaVersion: 1,
				kind: "alpha-release-package",
				target,
				file,
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				context: context("package-vsix", platform, arch),
				build: {
					status: "verified",
					sourceTreeState: "clean",
					sourceRevision: source.commit,
					manifestDigest: hash,
					sourceTreeDigest: hash,
					artifactTreeDigest: hash,
					entrypointSha256: hash,
					packageJsonSha256: hash,
				},
			}
		}),
	)
}

async function fixture(t) {
	const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-release-evidence-"))
	t.after(() => rm(directory, { recursive: true, force: true }))
	return {
		root,
		expected,
		now,
		needs,
		version: "3.2.22",
		packageDirectory: directory,
		validation: structuredClone(await validationFixtures()),
		packages: await packages(directory),
	}
}

test("aggregation admits all unchanged harness inventories and six bound native package identities", async (t) => {
	const input = await fixture(t)
	assert.throws(
		() => validatePackageEvidence(input.packages[0], { expected, version: "../outside", now }),
		/invalid_release_version/u,
	)
	const result = await aggregateReleaseEvidence(input)
	assert.equal(result.status, "passed")
	assert.equal(result.validation.length, 13)
	assert.equal(result.packages.length, 6)
	assert.deepEqual(result.context, expected)
	const outcomes = input.validation.find((value) => value.lane === "outcomes")
	outcomes.outcomeBuild = { ...outcomes.outcomeBuild, bundleSha256: "b".repeat(64) }
	await assert.rejects(aggregateReleaseEvidence(input), /noncomparable_outcome_build/u)
})

for (const job of Object.keys(needs))
	for (const result of ["failure", "cancelled", "skipped", undefined])
		test(`required ${job} result ${result} cannot be rescued by retained green artifacts`, () => {
			assert.throws(() => requireReleaseNeeds({ ...needs, [job]: { result } }), /required_job_not_successful/u)
		})

test("job receipts retain SHA, Git tree, working bytes, toolchain, run/attempt, host and freshness", async () => {
	const value = await validation("static")
	for (const mutate of [
		(v) => (v.context.source.commit = "c".repeat(40)),
		(v) => (v.context.source.dirty = true),
		(v) => (v.context.source.treeSha256 = "invalid"),
		(v) => (v.context.gitTree = "c".repeat(40)),
		(v) => (v.context.node = "25.0.0"),
		(v) => (v.context.pnpm = "11.0.0"),
		(v) => (v.context.ci.runId = "124"),
		(v) => (v.context.ci.runAttempt = "2"),
		(v) => (v.context.platform = "linux"),
		(v) => (v.context.createdAt = "2026-09-30T00:00:00Z"),
		(v) => (v.report.sourceAtEnd.treeSha256 = "c".repeat(64)),
		(v) => (v.report.finishedAt = "2026-09-30T00:00:00Z"),
		(v) => (v.report.status = "cancelled"),
		(v) => (v.report.steps[0].status = "not_started"),
	]) {
		const changed = structuredClone(value)
		mutate(changed)
		await assert.rejects(validateValidationEvidence(changed, { root, expected, now }), /release_evidence:/u)
	}
	validateJobContext(value.context, expected, "validation", "win32", now)
})

test("test inventory omission, wrong exact host and changed package provenance fail admission", async (t) => {
	const offline = await validation("offline")
	offline.report.steps[1].evidence.receipt.files.pop()
	offline.report.steps[1].evidence.receipt.counts.total--
	offline.report.steps[1].evidence.receipt.counts.passed--
	await assert.rejects(validateValidationEvidence(offline, { root, expected, now }), /incomplete_test_inventory/u)
	const host = await validation("host")
	host.report.steps[0].evidence.receipts[0].actualHostVersion = "1.125.0"
	await assert.rejects(validateValidationEvidence(host, { root, expected, now }), /invalid_host_receipt/u)
	const input = await fixture(t)
	for (const patch of [{ target: "alpine-x64" }, { file: "../other.vsix" }, { sha256: "bad" }])
		assert.throws(
			() =>
				validatePackageEvidence({ ...input.packages[0], ...patch }, { expected, version: input.version, now }),
			/release_evidence:/u,
		)
	const dirty = structuredClone(input.packages[0])
	dirty.build.sourceTreeState = "modified"
	assert.throws(
		() => validatePackageEvidence(dirty, { expected, version: input.version, now }),
		/invalid_clean_build_provenance/u,
	)
})

test("missing or duplicate jobs, packages, checkout bytes and changed uploaded bytes block aggregation", async (t) => {
	const input = await fixture(t)
	for (const mutate of [
		(v) => v.validation.pop(),
		(v) => (v.validation[0] = v.validation[1]),
		(v) => v.packages.pop(),
		(v) => (v.packages[0] = v.packages[1]),
		(v) => {
			v.validation[1].context.source.treeSha256 = "c".repeat(64)
			v.validation[1].report.source = v.validation[1].context.source
			v.validation[1].report.sourceAtEnd = v.validation[1].context.source
		},
	]) {
		const changed = structuredClone(input)
		mutate(changed)
		await assert.rejects(aggregateReleaseEvidence(changed), /release_evidence:/u)
	}
	await writeFile(path.join(input.packageDirectory, input.packages[0].file), "changed payload")
	await assert.rejects(aggregateReleaseEvidence(input), /changed_package_bytes/u)
})

test("ordinary unit supplemental skips remain recorded while skipped executions remain rejected", async () => {
	const value = await validation("unit")
	const receipt = value.report.steps[1].evidence.receipt
	receipt.counts.total++
	receipt.counts.skipped++
	receipt.files[0].counts.total++
	receipt.files[0].counts.skipped++
	const result = await validateValidationEvidence(value, { root, expected, now })
	assert.equal(result.admission.state, "skipped")
	assert.equal(result.admission.reason, "supplemental_tests_skipped")
	value.report.steps[1].status = "not_started"
	await assert.rejects(validateValidationEvidence(value, { root, expected, now }), /failed_or_skipped_required_step/u)
	value.report.steps[1].status = "passed"
	for (const row of receipt.files) {
		row.counts.passed = 0
		row.counts.skipped = row.counts.total
	}
	receipt.counts.passed = 0
	receipt.counts.skipped = receipt.counts.total
	await assert.rejects(validateValidationEvidence(value, { root, expected, now }), /no_tests_executed/u)
})

test("native platforms retain distinct checkout byte identities without changing commit or Git tree", async (t) => {
	const input = await fixture(t)
	for (const value of input.packages.filter((value) => value.target.startsWith("darwin-"))) {
		value.context.source.treeSha256 = "c".repeat(64)
		value.context.source.lockfileSha256 = "d".repeat(64)
	}
	const result = await aggregateReleaseEvidence(input)
	assert.equal(result.status, "passed")
	assert.equal(
		result.packages.find((value) => value.target === "darwin-arm64").context.source.treeSha256,
		"c".repeat(64),
	)
})

test("tooling retains host-runner supplemental skips while its repository tests remain a hard gate", async () => {
	const value = await validation("tooling")
	const skip = (receipt) => {
		receipt.counts.total++
		receipt.counts.skipped++
		receipt.files[0].counts.total++
		receipt.files[0].counts.skipped++
	}
	skip(value.report.steps[2].evidence.receipt)
	const result = await validateValidationEvidence(value, { root, expected, now })
	assert.equal(result.admission.reason, "supplemental_tests_skipped")
	skip(value.report.steps[1].evidence.receipt)
	await assert.rejects(validateValidationEvidence(value, { root, expected, now }), /skipped_hard_gate/u)
})

test("the publication inventory rejects extra packages regardless of filename case", async (t) => {
	const input = await fixture(t)
	await writeFile(path.join(input.packageDirectory, "unexpected.VSIX"), "unexpected")
	await assert.rejects(aggregateReleaseEvidence(input), /unexpected_package_inventory/u)
})

test("failed/skipped aggregate jobs produce a failing diagnostic receipt without needing model or host execution", async (t) => {
	const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-release-failed-"))
	t.after(() => rm(directory, { recursive: true, force: true }))
	const result = await releaseEvidenceCli(
		[
			"aggregate",
			"--validation-root",
			"missing",
			"--packages",
			"missing",
			"--output",
			"artifacts/harness/failure.json",
		],
		{
			root: directory,
			env: { RELEASE_NEEDS: JSON.stringify({ ...needs, validation: { result: "skipped" } }) },
		},
	)
	assert.equal(result.status, "failed")
	assert.equal(result.failure, "release_evidence:required_job_not_successful")
	assert.equal(JSON.parse(await readFile(path.join(directory, "artifacts/harness/failure.json"))).status, "failed")
})

test("the publish-side verifier runs without installed dependencies and rejects changed bytes or stale barriers", async (t) => {
	const input = await fixture(t)
	const barrier = structuredClone(await aggregateReleaseEvidence(input))
	const directory = await mkdtemp(path.join(os.tmpdir(), "alpha-release-publication-"))
	t.after(() => rm(directory, { recursive: true, force: true }))
	for (const relative of [
		"scripts/harness/release-evidence.mjs",
		"scripts/harness/release-quality.mjs",
		"scripts/harness/pnpm.mjs",
		"src/lancedb-native.mjs",
	]) {
		await mkdir(path.dirname(path.join(directory, relative)), { recursive: true })
		await cp(path.join(root, relative), path.join(directory, relative))
	}
	await mkdir(path.join(directory, "bin"))
	await mkdir(path.join(directory, "artifacts/harness"), { recursive: true })
	await writeFile(
		path.join(directory, "package.json"),
		JSON.stringify({ packageManager: "pnpm@11.24.0", engines: { node: "24.21.0" } }),
	)
	await writeFile(path.join(directory, "src/package.json"), JSON.stringify({ version: "3.2.22" }))
	await writeFile(path.join(directory, ".gitignore"), "bin\nartifacts\n")
	for (const value of input.packages)
		await cp(path.join(input.packageDirectory, value.file), path.join(directory, "bin", value.file))
	const git = (...args) =>
		execFileSync("git", ["-c", "core.hooksPath=disabled", "-c", "commit.gpgsign=false", ...args], {
			cwd: directory,
			encoding: "utf8",
			windowsHide: true,
		}).trim()
	git("init", "-q", "--initial-branch=main")
	git("config", "user.name", "Release fixture")
	git("config", "user.email", "fixture@example.invalid")
	git("add", ".")
	git("commit", "-q", "-m", "fixture")
	const revision = git("rev-parse", "HEAD")
	const gitTree = git("rev-parse", "HEAD^{tree}")
	const timestamp = new Date().toISOString()
	for (const value of [
		barrier.context,
		...barrier.validation.map((value) => value.context),
		...barrier.packages.map((value) => value.context),
	]) {
		value.source.commit = revision
		value.gitTree = gitTree
		value.createdAt = timestamp
	}
	for (const value of barrier.packages) value.build.sourceRevision = revision
	barrier.generatedAt = timestamp
	const file = path.join(directory, "artifacts/harness/release-gate.json")
	const env = {
		...process.env,
		NODE_PATH: "",
		GITHUB_ACTIONS: "true",
		GITHUB_JOB: "publish-release",
		GITHUB_SHA: revision,
		GITHUB_RUN_ID: expected.ci.runId,
		GITHUB_RUN_ATTEMPT: expected.ci.runAttempt,
		RELEASE_NEEDS: JSON.stringify({ ...needs, "release-gate": { result: "success" } }),
	}
	const run = () =>
		execFileSync(
			process.execPath,
			[
				path.join(directory, "scripts/harness/release-evidence.mjs"),
				"verify-publication",
				"--input",
				"artifacts/harness/release-gate.json",
				"--packages",
				"bin",
			],
			{ cwd: directory, env, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
		)
	await writeFile(file, JSON.stringify(barrier))
	assert.equal(JSON.parse(run()).status, "passed")
	for (const mutate of [
		(value) => (value.status = "failed"),
		(value) => (value.generatedAt = "2020-01-01T00:00:00Z"),
		(value) => (value.context.source.commit = "c".repeat(40)),
		(value) => (value.context.ci.runAttempt = "2"),
		(value) => value.validation.pop(),
		(value) => (value.validation[0].admission.state = "skipped"),
		(value) => (value.context.source.dirty = true),
	]) {
		const changed = structuredClone(barrier)
		mutate(changed)
		await writeFile(file, JSON.stringify(changed))
		assert.throws(run, (error) => error.status === 1 && /release_evidence:/u.test(error.stderr))
	}
	await writeFile(file, JSON.stringify(barrier))
	await writeFile(path.join(directory, "bin", input.packages[0].file), "modified after aggregation")
	assert.throws(run, (error) => error.status === 1 && /changed_package_bytes/u.test(error.stderr))
})
