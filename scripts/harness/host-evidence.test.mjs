import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { test } from "node:test"
import {
	confidenceHostFiles,
	extendedHostFiles,
	managedHostFiles,
	minimumHostFiles,
	hostSuiteVerdict,
	hostSuiteCleanupVerified,
	outcomeCampaignVerdict,
	renderedHostFiles,
	smokeHostFiles,
	stressHostFiles,
	validateHostReceipt,
} from "./host-evidence.mjs"

import { hostReceipt, outcomeFixture } from "./fixtures/evidence.mjs"

const closedSmokePrefix = (length) =>
	smokeHostFiles.slice(0, length).map((file, index) => ({
		...hostReceipt(file),
		startedAt: new Date(Date.parse("2026-10-02T10:00:00Z") + index * 2000).toISOString(),
		completedAt: new Date(Date.parse("2026-10-02T10:00:00Z") + index * 2000 + 1000).toISOString(),
	}))

test("a serial failed assertion can prove owned shutdown without proving full suite acceptance", () => {
	const prefix = closedSmokePrefix(3)
	Object.assign(prefix.at(-1), {
		status: "failed",
		exitCode: 1,
		failure: "host-failed",
		testCounts: { total: 1, passed: 0, pending: 0, executed: 1, failed: 1 },
	})
	assert.equal(hostSuiteVerdict(prefix, "smoke").status, "failed")
	assert.equal(hostSuiteCleanupVerified(prefix, "smoke", 1), true)
	assert.equal(hostSuiteCleanupVerified(closedSmokePrefix(smokeHostFiles.length), "smoke", 0), true)
	assert.equal(
		hostSuiteCleanupVerified(prefix.slice(0, -1), "smoke", 1),
		false,
		"a missing next host receipt is still unknown",
	)
	assert.equal(
		hostSuiteCleanupVerified(prefix, "smoke", 0),
		false,
		"a partial roster needs the observed serial failure exit",
	)
	for (const mutate of [
		(values) => (values[2].hostExitObserved = false),
		(values) => (values[2].hostCleanupVerified = false),
		(values) => (values[2].ownershipGate = null),
		(values) => (values[2].execution = "test-seam"),
		(values) => (values[2].actualHostVersion = "1.125.0"),
		(values) => (values[2].exitCode = undefined),
		(values) => (values[2].runId = values[0].runId),
		(values) => (values[1].testFile = "unregistered.test"),
		(values) => (values[1].startedAt = values[0].startedAt),
	]) {
		const unknown = structuredClone(prefix)
		mutate(unknown)
		assert.equal(hostSuiteCleanupVerified(unknown, "smoke", 1), false)
	}
})

for (const [suite, files] of [
	["rendered", renderedHostFiles],
	["stress", stressHostFiles],
]) {
	test(`${suite} requires every complete scripted exact-host receipt and rejects partial or foreign evidence`, () => {
		const receipts = files.map(hostReceipt)
		assert.equal(hostSuiteVerdict(receipts, suite).status, "passed")
		assert.equal(hostSuiteVerdict(receipts.slice(1), suite).reason, "incomplete_host_suite")
		for (const mutate of [
			(values) => (values[1].runId = values[0].runId),
			(values) => (values[0].providerMode = "live-copilot"),
			(values) => (values[0].actualHostVersion = "1.125.0"),
			(values) => (values[0].testCounts = { total: 2, passed: 1, pending: 1, executed: 1, failed: 0 }),
			(values) => (values[0].testSelection.grep = "subset"),
			(values) => (values[0].testSelection.forbidOnly = false),
			(values) => (values[0].hostExitObserved = false),
			(values) => (values[0].hostCleanupVerified = false),
			(values) => (values[0].retentionStatus = "failed"),
		]) {
			const incomplete = structuredClone(receipts)
			mutate(incomplete)
			assert.equal(hostSuiteVerdict(incomplete, suite).status, "failed")
		}
	})
}

test("whole host suites reject filtered, focused, or legacy selection evidence", () => {
	for (const selection of [
		undefined,
		null,
		{ testFile: "extension.test", grep: "passing", forbidOnly: true },
		{ testFile: "extension.test", grep: null, forbidOnly: false },
		{ testFile: "another.test", grep: null, forbidOnly: true },
	]) {
		const receipts = smokeHostFiles.map(hostReceipt)
		receipts[0].testSelection = selection
		assert.equal(hostSuiteVerdict(receipts, "smoke").status, "failed", JSON.stringify(selection))
	}
})

test("legacy schema-one receipts stay readable without proving a complete gate", () => {
	const legacy = hostReceipt()
	delete legacy.testSelection
	const normalized = validateHostReceipt(legacy)
	assert.equal(normalized.schemaVersion, 1)
	assert.equal(normalized.testSelection, null)
	assert.deepEqual(validateHostReceipt(normalized), normalized)
	const { campaign, receipts } = outcomeFixture()
	delete receipts[0].testSelection
	assert.equal(outcomeCampaignVerdict(campaign, receipts, campaign.id).reason, "incomplete_host_selection")
})

test("minimum host evidence is exact and cannot satisfy the reference-host gate", () => {
	const receipts = minimumHostFiles.map((file) => ({
		...hostReceipt(file),
		requestedHostVersion: "1.125.0",
		actualHostVersion: "1.125.0",
	}))
	assert.equal(hostSuiteVerdict(receipts, "minimum").status, "passed")
	assert.equal(hostSuiteCleanupVerified(receipts, "minimum", 0), true)
	assert.throws(() => validateHostReceipt(receipts[0]), /receipt/)
	assert.equal(hostSuiteVerdict(receipts, "smoke").status, "failed")
	assert.equal(hostSuiteVerdict(minimumHostFiles.map(hostReceipt), "minimum").status, "failed")
	for (const mutate of [
		(values) => (values[0].requestedHostVersion = "1.138.0"),
		(values) => (values[0].actualHostVersion = "1.126.0"),
		(values) => (values[0].testCounts = { total: 2, passed: 1, pending: 1, executed: 1, failed: 0 }),
		(values) => (values[0].testSelection.grep = "subset"),
	]) {
		const invalid = structuredClone(receipts)
		mutate(invalid)
		assert.equal(hostSuiteVerdict(invalid, "minimum").status, "failed")
	}
})

test("managed automated host evidence requires all four existing host files and owned shutdown", async () => {
	const receipts = managedHostFiles.map(hostReceipt)
	assert.equal(hostSuiteVerdict(receipts, "managed").status, "passed")
	assert.equal(hostSuiteVerdict(receipts.slice(0, 2), "managed").status, "failed")
	receipts[3].hostExitObserved = false
	assert.equal(hostSuiteCleanupVerified(receipts, "managed", 0), false)
	const manifest = JSON.parse(await readFile(new URL("../../apps/vscode-e2e/package.json", import.meta.url), "utf8"))
	const files = (script) => [...script.matchAll(/--file ([\w.-]+)/g)].map((match) => match[1])
	assert.deepEqual(managedHostFiles, files(manifest.scripts["test:managed-agents:run"]))
	assert.deepEqual(minimumHostFiles, files(manifest.scripts["test:compatibility:1250:run"]))
})

test("host inventory matches the canonical runner scripts and requires background launch receipts", async () => {
	const manifest = JSON.parse(await readFile(new URL("../../apps/vscode-e2e/package.json", import.meta.url), "utf8"))
	const files = (script) => [...script.matchAll(/--file ([\w.-]+)/g)].map((match) => match[1])
	assert.deepEqual(smokeHostFiles, files(manifest.scripts["test:smoke:1380:run"]))
	assert.deepEqual(confidenceHostFiles, [...smokeHostFiles, ...files(manifest.scripts["test:core:1380:run"])])
	assert.deepEqual(extendedHostFiles, files(manifest.scripts["test:extended:1380:run"]))
	for (const [suite, expected] of [
		["smoke", smokeHostFiles],
		["confidence", confidenceHostFiles],
	]) {
		assert.ok(expected.includes("background-command-completion.test"))
		const receipts = expected.map(hostReceipt)
		assert.equal(hostSuiteVerdict(receipts, suite).status, "passed")
		assert.equal(
			hostSuiteVerdict(
				receipts.filter((receipt) => receipt.testFile !== "background-command-completion.test"),
				suite,
			).reason,
			"incomplete_host_suite",
		)
		assert.equal(
			hostSuiteVerdict([...receipts, hostReceipt("unregistered-contract.test")], suite).reason,
			"incomplete_host_suite",
		)
	}
})

test("host gate revalidates receipts and refuses unknown, partial, skipped, or contradictory suites", () => {
	for (const file of [...smokeHostFiles, ...confidenceHostFiles])
		assert.equal(validateHostReceipt(hostReceipt(file)).testFile, file)
	const receipts = confidenceHostFiles.map(hostReceipt)
	assert.equal(hostSuiteVerdict(receipts, "confidence").status, "passed")
	assert.equal(hostSuiteVerdict(receipts, "unknown").status, "failed")
	assert.equal(hostSuiteVerdict(receipts.slice(1), "confidence").status, "failed")
	for (const mutate of [
		(value) => (value.actualHostVersion = "1.125.0"),
		(value) => (value.requestedHostVersion = "1.125.0"),
		(value) => (value.actualHostVersion = "1.126.0"),
		(value) => (value.execution = "test-seam"),
		(value) => (value.testCounts = { total: 2, passed: 1, pending: 1, executed: 1, failed: 0 }),
		(value) => (value.failure = "host-failed"),
		(value) => (value.captureComplete = false),
		(value) => (value.requireAllTests = false),
	]) {
		const value = hostReceipt()
		mutate(value)
		assert.throws(() => validateHostReceipt(value), /receipt/)
	}
})

test("outcome evidence uses emitter scenarioPhase and binds every attempt to the observed host", () => {
	const { campaign, receipts } = outcomeFixture()
	assert.equal(outcomeCampaignVerdict(campaign, receipts, campaign.id).status, "passed")
	for (const mutate of [
		(c, r) => (r[0].runId = "unrelated-host"),
		(c, r) => (r[0].scenarioPhase = "prepare"),
		(c) => (c.attempts[0].evidence = "../foreign/evidence-index.json"),
		(c) => (c.attempts[0].result.failure = { class: "assertion" }),
		(c) => (c.attempts[0].result.retentionFailed = true),
		(c) => (c.finishedAt = "2026-10-02T09:00:00.000Z"),
		(c) => (c.evaluationIdentity.unchanged = false),
		(c) => (c.attempts[0].request.sample = 2),
		(c) => (c.evaluationPlan.scenarioIds[1] = c.evaluationPlan.scenarioIds[0]),
	]) {
		const input = structuredClone({ campaign, receipts })
		mutate(input.campaign, input.receipts)
		assert.equal(outcomeCampaignVerdict(input.campaign, input.receipts, campaign.id).status, "failed")
	}
})

test("outcome evidence admits native Windows paths while retaining exact attempt binding", () => {
	const { campaign, receipts } = outcomeFixture()
	for (const attempt of campaign.attempts)
		attempt.evidence = path.win32.join(attempt.request.attemptId, "evidence-index.json")
	const verdict = outcomeCampaignVerdict(campaign, receipts, campaign.id)
	assert.equal(verdict.status, "passed")
	const expected = campaign.attempts.map((attempt) => `${attempt.request.attemptId}/evidence-index.json`)
	assert.deepEqual(
		verdict.scenarios.map((scenario) => scenario.evidence),
		expected,
	)
	assert.deepEqual(
		verdict.campaign.attempts.map((attempt) => attempt.evidence),
		expected,
	)
	assert.equal(outcomeCampaignVerdict(verdict.campaign, verdict.receipts, campaign.id).status, "passed")
	for (const evidence of [
		"attempt-0002\\evidence-index.json",
		"attempt-0001\\..\\attempt-0001\\evidence-index.json",
		"attempt-0001\\\\evidence-index.json",
		"\\attempt-0001\\evidence-index.json",
		"C:\\attempt-0001\\evidence-index.json",
		"attempt-0001\\.\\evidence-index.json",
	]) {
		const invalid = structuredClone(campaign)
		invalid.attempts[0].evidence = evidence
		assert.equal(outcomeCampaignVerdict(invalid, receipts, campaign.id).status, "failed", evidence)
	}
})

test("confidence requires a distinct observed host run for every required file", () => {
	const receipts = confidenceHostFiles.map(hostReceipt)
	receipts[1].runId = receipts[0].runId
	assert.equal(hostSuiteVerdict(receipts, "confidence").status, "failed")
})

test("a completed disposable smoke receipt cannot infer ownership from passed tests and exit zero", () => {
	// The real extension.test smoke shape exposed a missing producer ancestry gate for disposable profiles.
	const receipt = {
		...hostReceipt("extension.test"),
		profile: { kind: "disposable", sha256: "a".repeat(64) },
		ownershipGate: null,
		testCounts: { total: 5, passed: 5, pending: 0, executed: 5, failed: 0 },
	}
	assert.equal(receipt.status, "passed")
	assert.equal(receipt.hostExitObserved, true)
	assert.equal(receipt.captureComplete, true)
	assert.throws(() => validateHostReceipt(receipt), /receipt/)
})

test("smoke contracts require the provider selected by their canonical scripts", async () => {
	const manifest = JSON.parse(await readFile(new URL("../../apps/vscode-e2e/package.json", import.meta.url), "utf8"))
	const receipts = manifest.scripts["test:smoke:1380:run"]
		.split(" && ")
		.filter((command) => command.includes("--file "))
		.map((command) => ({
			...hostReceipt(command.match(/--file ([\w.-]+)/)[1]),
			providerMode: command.match(/--provider ([\w-]+)/)[1],
		}))
	assert.equal(hostSuiteVerdict(receipts, "smoke").status, "passed")
	for (const index of [
		0,
		smokeHostFiles.indexOf("vscode-lm-contract.test"),
		smokeHostFiles.indexOf("claude-copilot-contract.test"),
	]) {
		const modified = structuredClone(receipts)
		modified[index].providerMode = modified[index].providerMode === "scripted" ? "vscode-lm-fixture" : "scripted"
		assert.equal(hostSuiteVerdict(modified, "smoke").status, "failed")
	}
})

test("confidence composes all fifteen smoke hosts and five core hosts without admitting unit fixtures", () => {
	assert.equal(smokeHostFiles.length, 15)
	assert.equal(confidenceHostFiles.length, 20)
	assert.deepEqual(confidenceHostFiles.slice(0, smokeHostFiles.length), smokeHostFiles)
	const receipts = confidenceHostFiles.map(hostReceipt)
	assert.equal(hostSuiteVerdict(receipts, "confidence").status, "passed")
	assert.equal(
		hostSuiteVerdict(
			receipts.filter((receipt) => !smokeHostFiles.includes(receipt.testFile)),
			"confidence",
		).reason,
		"incomplete_host_suite",
	)
	const wrongProvider = structuredClone(receipts)
	wrongProvider.find((receipt) => receipt.testFile === "vscode-lm-contract.test").providerMode = "scripted"
	assert.equal(hostSuiteVerdict(wrongProvider, "confidence").reason, "wrong_host_provider")
	const unitFixture = {
		...hostReceipt(),
		testFile: null,
		status: "blocked",
		failure: "host-not-owned",
		ownershipGate: null,
	}
	assert.equal(hostSuiteVerdict([...receipts, unitFixture], "confidence").reason, "invalid_host_receipt")
})

test("distinct outcome scenarios cannot reuse an attempt, evidence index, or observed host run", () => {
	const { campaign, receipts } = outcomeFixture()
	campaign.attempts[1].request.attemptId = campaign.attempts[0].request.attemptId
	campaign.attempts[1].evidence = campaign.attempts[0].evidence
	receipts[1].runId = receipts[0].runId
	assert.equal(outcomeCampaignVerdict(campaign, receipts, campaign.id).status, "failed")
})

test("extended coverage requires distinct complete scripted receipts from the exact reference host", () => {
	const receipts = extendedHostFiles.map(hostReceipt)
	assert.equal(hostSuiteVerdict(receipts, "extended").status, "passed")
	assert.equal(hostSuiteVerdict(receipts, "smoke").reason, "incomplete_host_suite")
	assert.equal(hostSuiteVerdict(receipts.slice(1), "extended").reason, "incomplete_host_suite")
	assert.equal(
		hostSuiteVerdict([...receipts, hostReceipt("unregistered-contract.test")], "extended").reason,
		"incomplete_host_suite",
	)
	for (const mutate of [
		(values) => (values[1].runId = values[0].runId),
		(values) => (values[1].testFile = values[0].testFile),
		(values) => (values[0].providerMode = "vscode-lm-fixture"),
		(values) => (values[0].actualHostVersion = "1.126.0"),
		(values) => (values[0].testCounts = { total: 2, passed: 1, pending: 1, executed: 1, failed: 0 }),
		(values) => (values[0].ownershipGate = null),
		(values) => (values[0].requireAllTests = false),
	]) {
		const incomplete = structuredClone(receipts)
		mutate(incomplete)
		assert.equal(hostSuiteVerdict(incomplete, "extended").status, "failed")
	}
})
