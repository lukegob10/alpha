import { test } from "node:test"
import * as assert from "node:assert/strict"
import { runCampaign } from "../controller"
import { parseCampaignConfig } from "../config"
import type { CampaignConfig, CampaignOperations, CampaignReport, ScenarioResult } from "../types"
import { compareLiveProviderIdentity } from "../../liveProviderIdentity"

const config = (): CampaignConfig => ({
	id: "campaign-test",
	hosts: [{ version: "1.138.0" }],
	scenarioIds: ["review", "review-secondary"],
	samples: 1,
	provider: { mode: "scripted" },
	budgets: { maxIterations: 20, maxRequests: 20, maxDurationMs: 60_000, attemptTimeoutMs: 1_000 },
	maxReproductions: 2,
})
const result = (status: ScenarioResult["status"] = "passed"): ScenarioResult => ({
	status,
	...(status === "passed" ? {} : { failure: { class: "assertion" as const, fingerprint: "missing-effect" } }),
	usage: { requests: 1, inputTokens: null, outputTokens: null, cost: null },
})
const harness = (results: ScenarioResult[] = []) => {
	const events: string[] = []
	const reports: CampaignReport[] = []
	const operations: CampaignOperations = {
		runScenario: async (request) => {
			events.push(`run:${request.host.version}:${request.scenarioId}:${request.phase}`)
			return results.shift() ?? result()
		},
		preserveEvidence: async (request) => {
			events.push(`evidence:${request.attemptId}`)
			return `${request.attemptId}/manifest.json`
		},
		persistReport: async (report) => {
			reports.push(report)
		},
	}
	return { operations, events, reports }
}

test("retention release happens only after a durable terminal report and records secondary failure", async () => {
	const { operations, reports } = harness()
	operations.finalizeRetention = async (terminal) => {
		assert.ok(terminal.finishedAt)
		assert.equal(terminal.stopReason, "completed")
		assert.equal(reports.at(-1)?.finishedAt, terminal.finishedAt)
		return { status: "blocked", receipt: "retention-result.json" }
	}
	const report = await runCampaign(config(), operations)
	assert.equal(report.stopReason, "completed")
	assert.equal(reports.at(-1)?.retention?.status, "blocked")
})

test("failed terminal persistence never releases campaign evidence", async () => {
	const { operations } = harness()
	let finalized = false
	operations.persistReport = async (report) => {
		if (report.finishedAt) throw new Error("disk full")
	}
	operations.finalizeRetention = async () => {
		finalized = true
		return { status: "complete" }
	}
	await assert.rejects(runCampaign(config(), operations), /disk full/)
	assert.equal(finalized, false)
})

test("storage admission blockers stop before a second model attempt with zero known usage", async () => {
	for (const fingerprint of ["storage_budget", "scan_incomplete"] as const) {
		const { operations } = harness([
			{
				status: "blocked",
				failure: { class: "infrastructure", fingerprint },
				usage: { requests: 0, inputTokens: null, outputTokens: null, cost: null },
			},
		])
		const report = await runCampaign(config(), operations)
		assert.equal(report.stopReason, fingerprint)
		assert.equal(report.usage.requests, 0)
		assert.equal(report.attempts.length, 1)
	}
})

test("secondary retention failure preserves the primary authentication outcome", async () => {
	const { operations } = harness([
		{ ...result("blocked"), failure: { class: "authentication", fingerprint: "auth" }, retentionFailed: true },
	])
	operations.finalizeRetention = async () => ({ status: "failed", receipt: "retention-result.json" })
	const report = await runCampaign(config(), operations)
	assert.equal(report.stopReason, "authentication")
	assert.equal(report.attempts[0]?.result.failure?.fingerprint, "auth")
	assert.equal(report.retention?.status, "failed")
})

test("diagnostics follow the original samples and retain their failures separately", async () => {
	const { operations, events, reports } = harness([result("failed"), result(), result("failed")])
	const report = await runCampaign({ ...config(), collectionMode: "sample-then-diagnose" }, operations)
	assert.equal(report.stopReason, "completed")
	assert.deepEqual(report.counts, { passed: 1, failed: 2, blocked: 0 })
	assert.deepEqual(report.sampling, {
		planned: 2,
		completed: 2,
		passed: 1,
		failed: 1,
		blocked: 0,
		notRun: 0,
		diagnosticAttempts: 1,
	})
	assert.equal(report.mode, "report-only")
	assert.equal(report.usage.requests, 3)
	assert.equal(report.usage.cost, null)
	assert.deepEqual(events.slice(0, 4), [
		"run:1.138.0:review:sample",
		"evidence:attempt-0001",
		"run:1.138.0:review-secondary:sample",
		"evidence:attempt-0002",
	])
	assert.equal(reports[0]!.attempts.length, 0, "checkpoint snapshots must not mutate afterward")
	assert.equal(reports.at(-1)?.stopReason, "completed")
})

test("ordinary sampling finishes every planned cell after an intermittent failure", async () => {
	const settings = { ...config(), scenarioIds: ["review"], samples: 3 }
	const { operations, reports } = harness([result("failed"), result(), result()])
	const report = await runCampaign(settings, operations)
	assert.equal(report.stopReason, "completed")
	assert.deepEqual(
		report.attempts.map(({ request }) => [request.sample, request.phase]),
		[
			[1, "sample"],
			[2, "sample"],
			[3, "sample"],
		],
	)
	assert.deepEqual(report.sampling, {
		planned: 3,
		completed: 3,
		passed: 2,
		failed: 1,
		blocked: 0,
		notRun: 0,
		diagnosticAttempts: 0,
	})
	assert.deepEqual(reports[0]!.sampling, { ...report.sampling, completed: 0, passed: 0, failed: 0, notRun: 3 })
})

test("campaign budgets and workload identity remain the pre-run snapshot across awaited callbacks", async () => {
	const settings = config()
	settings.budgets.maxRequests = 1
	settings.provider = { mode: "live-copilot", modelId: "declared-model", effort: "high" }
	const { operations, reports } = harness()
	operations.runScenario = async () => {
		settings.budgets.maxRequests = 100
		settings.provider.modelId = "later-model"
		settings.hosts[0]!.executable = "changed-host"
		return result()
	}
	const report = await runCampaign(settings, operations)
	assert.equal(report.stopReason, "request_budget")
	assert.equal(report.attempts.length, 1)
	assert.deepEqual(report.sampling, {
		planned: 2,
		completed: 1,
		passed: 1,
		failed: 0,
		blocked: 0,
		notRun: 1,
		diagnosticAttempts: 0,
	})
	assert.equal(report.requestedProvider.modelId, "declared-model")
	assert.equal(report.attempts[0]!.request.provider.modelId, "declared-model")
	assert.equal(report.attempts[0]!.request.host.executable, undefined)
	assert.equal(reports[0]!.requestedProvider.modelId, "declared-model")
})

test("each dispatched request protects the original cell, allowance and provider from callback mutation", async () => {
	const { operations } = harness()
	operations.runScenario = async (request) => {
		assert.equal(Reflect.set(request, "phase", "reproduce"), false)
		assert.equal(Reflect.set(request, "requestLimit", 1_000), false)
		assert.equal(Reflect.set(request.provider, "mode", "live-copilot"), false)
		assert.equal(Reflect.set(request.host, "version", "0.0.0"), false)
		return result()
	}
	const report = await runCampaign(config(), operations)
	assert.equal(report.stopReason, "completed")
	assert.deepEqual(
		report.attempts.map(({ request }) => request.phase),
		["sample", "sample"],
	)
	assert.equal(report.attempts[0]!.request.requestLimit, 20)
})

test("a passed claim carrying a failure cannot become a successful original sample", async () => {
	const { operations } = harness([{ ...result(), failure: { class: "assertion", fingerprint: "failed-oracle" } }])
	const report = await runCampaign(config(), operations)
	assert.equal(report.stopReason, "infrastructure")
	assert.equal(report.counts.passed, 0)
	assert.equal(report.sampling?.passed, 0)
	assert.equal(report.sampling?.blocked, 1)
	assert.equal(report.sampling?.notRun, 1)
})

test("predeclared decision identity and wall-clock start are captured before each dispatch", async () => {
	const digest = `sha256:${"d".repeat(64)}`
	const { operations } = harness()
	operations.wallTime = () => "2026-10-23T12:00:00.000Z"
	operations.runScenario = async (request) => {
		assert.equal(request.decisionPlanDigest, digest)
		assert.equal(request.startedAt, "2026-10-23T12:00:00.000Z")
		assert.equal(request.timeWindow, "declared-block")
		return result()
	}
	const report = await runCampaign(
		{ ...config(), decisionPlanDigest: digest, decisionTimeWindow: "declared-block" },
		operations,
	)
	assert.equal(report.stopReason, "completed")
	assert.ok(report.attempts.every(({ request }) => request.decisionPlanDigest === digest))
})

test("gate sampling preserves failures and covers remaining cells without paid reproductions", async () => {
	const { operations } = harness([result("failed"), result()])
	const report = await runCampaign(config(), operations, undefined, { reproduceFailures: false })
	assert.equal(report.stopReason, "completed")
	assert.deepEqual(report.counts, { passed: 1, failed: 1, blocked: 0 })
	assert.equal(report.usage.requests, 2)
	assert.deepEqual(
		report.attempts.map(({ request }) => request.phase),
		["sample", "sample"],
	)
	assert.ok(report.attempts.every(({ evidence }) => evidence))
})

test("gate sampling cannot bypass reproduction for source repair", async () => {
	const { operations, events, reports } = harness()
	const settings = config()
	settings.repair = { enabled: true, sourceRoot: "fixture", allowedPaths: [], plans: [] }
	await assert.rejects(
		runCampaign(settings, operations, undefined, { reproduceFailures: false }),
		/require failure reproduction/,
	)
	assert.deepEqual(events, [])
	assert.deepEqual(reports, [])
})

test("stops at iteration/request budgets without launching another host", async () => {
	for (const budget of ["maxIterations", "maxRequests"] as const) {
		const settings = config()
		settings.budgets[budget] = 1
		const { operations, events } = harness()
		const report = await runCampaign(settings, operations)
		assert.equal(report.stopReason, budget === "maxIterations" ? "iteration_budget" : "request_budget")
		assert.equal(events.filter((event) => event.startsWith("run:")).length, 1)
	}
})

test("unknown live usage stops the campaign, never counting it as zero", async () => {
	const unknown = result()
	unknown.usage.requests = null
	const { operations } = harness([unknown])
	const report = await runCampaign(config(), operations)
	assert.equal(report.stopReason, "usage_unavailable")
	assert.equal(report.usage.requests, null)
	assert.equal(report.attempts.length, 1)
})

test("malformed external usage or missing failure fingerprints cannot enter arithmetic or reproduction", async () => {
	for (const invalid of [
		{ ...result(), usage: { ...result().usage, requests: -1 } },
		{ ...result(), usage: { ...result().usage, cost: Number.NaN } },
		{ ...result("failed"), failure: undefined },
	]) {
		const { operations } = harness([invalid])
		const report = await runCampaign(config(), operations)
		assert.equal(report.stopReason, "infrastructure")
		assert.equal(report.attempts.length, 1)
		assert.equal(report.usage.requests, null)
	}
})

test("an over-budget request count is retained and stops further launches", async () => {
	const overrun = result()
	overrun.usage.requests = 21
	const { operations } = harness([overrun])
	const report = await runCampaign(config(), operations)
	assert.equal(report.stopReason, "request_budget")
	assert.equal(report.usage.requests, 21)
	assert.equal(report.attempts.length, 1)
})

test("attempt timeout waits for abort cleanup and persists a bounded failure", async () => {
	const settings = config()
	settings.budgets.attemptTimeoutMs = 5
	const { operations, events } = harness()
	operations.runScenario = async (_request, signal) => {
		await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }))
		events.push("cleanup")
		return result()
	}
	const report = await runCampaign(settings, operations)
	assert.equal(report.stopReason, "time_budget")
	assert.deepEqual(events, ["cleanup", "evidence:attempt-0001"])
	assert.equal(report.attempts.length, 1)
})

test("timeout preserves validated cleanup usage and identity without accepting late success", async (context) => {
	context.mock.timers.enable({ apis: ["setTimeout"] })
	for (const usage of [
		{ requests: 7, inputTokens: 100, outputTokens: 20, cost: 0.01 },
		{ requests: 7, inputTokens: null, outputTokens: 20, cost: null },
		{ requests: null, inputTokens: null, outputTokens: null, cost: null },
	]) {
		let announceStarted!: () => void
		const started = new Promise<void>((resolve) => {
			announceStarted = resolve
		})
		const { operations, reports } = harness()
		const observed: ScenarioResult = {
			...result(),
			usage,
			actualHostVersion: "1.138.0",
			model: { id: "observed-model", effort: "high" },
			taskIds: ["observed-task"],
			providerIdentity: compareLiveProviderIdentity(
				{ id: "github.copilot-chat", version: "1.0.0", entrypointSha256: "a".repeat(64) },
				{ id: "github.copilot-chat", version: "1.0.0", entrypointSha256: "a".repeat(64) },
			),
			performance: { firstResponseMs: 12, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
		}
		operations.runScenario = async (_request, signal) => {
			await new Promise<void>((resolve) => {
				signal.addEventListener("abort", () => resolve(), { once: true })
				announceStarted()
			})
			return observed
		}
		const pending = runCampaign(config(), operations)
		await started
		context.mock.timers.tick(config().budgets.attemptTimeoutMs)
		const report = await pending
		assert.equal(report.stopReason, "time_budget")
		assert.equal(report.attempts[0]?.result.status, "blocked")
		assert.equal(report.attempts[0]?.termination, "timeout")
		assert.equal(report.attempts[0]?.result.failure?.fingerprint, "time_budget")
		assert.deepEqual(report.attempts[0]?.result.usage, usage)
		assert.deepEqual(report.usage, usage)
		assert.deepEqual(report.attempts[0]?.result.model, observed.model)
		assert.deepEqual(report.attempts[0]?.result.taskIds, observed.taskIds)
		assert.equal(report.attempts[0]?.result.actualHostVersion, observed.actualHostVersion)
		assert.deepEqual(report.attempts[0]?.result.providerIdentity, observed.providerIdentity)
		assert.deepEqual(report.attempts[0]?.result.performance, observed.performance)
		assert.deepEqual(reports.at(-1)?.usage, usage)
	}
})

test("cancellation retains only validated cleanup observations", async () => {
	for (const valid of [true, false]) {
		const abort = new AbortController()
		const { operations } = harness()
		operations.runScenario = async () => {
			abort.abort()
			return { ...result(), usage: { requests: valid ? 7 : -7, inputTokens: 100, outputTokens: 20, cost: null } }
		}
		const report = await runCampaign(config(), operations, abort.signal)
		assert.equal(report.stopReason, "cancelled")
		assert.equal(report.attempts[0]?.result.status, "blocked")
		assert.equal(report.attempts[0]?.termination, "cancelled")
		assert.equal(report.usage.requests, valid ? 7 : null)
		assert.equal(report.usage.inputTokens, valid ? 100 : null)
	}
})

test("critical external blockers do not enter reproduction or repair", async () => {
	for (const failure of ["authentication", "usage_limit", "unsafe_repair"] as const) {
		const blocked = result("blocked")
		blocked.failure = { class: failure, fingerprint: failure }
		blocked.usage.requests = null
		const { operations } = harness([blocked])
		const report = await runCampaign(config(), operations)
		assert.equal(report.stopReason, failure)
		assert.equal(report.attempts.length, 1)
		assert.ok(report.attempts[0]!.evidence)
	}
})

test("non-reproductions remain diagnostic after the complete sample matrix", async () => {
	const { operations } = harness([result("failed"), result(), result(), result()])
	const report = await runCampaign({ ...config(), collectionMode: "sample-then-diagnose" }, operations)
	assert.equal(report.stopReason, "completed")
	assert.deepEqual(
		report.attempts.map((entry) => entry.request.phase),
		["sample", "sample", "reproduce", "reproduce"],
	)
	assert.equal(report.sampling?.passed, 1)
	assert.equal(report.sampling?.failed, 1)
	assert.equal(report.sampling?.diagnosticAttempts, 2)
})

test("evidence failure stops before another attempt or mutation", async () => {
	const { operations } = harness([result("failed")])
	operations.preserveEvidence = async () => {
		throw new Error("private path")
	}
	const report = await runCampaign(config(), operations)
	assert.equal(report.stopReason, "evidence_failed")
	assert.equal(report.attempts.length, 1)
	assert.equal(JSON.stringify(report).includes("private path"), false)
})

test("evidence failure retains independently validated usage without admitting another attempt", async () => {
	for (const requests of [57, null]) {
		const observed: ScenarioResult = {
			status: "blocked",
			failure: { class: "infrastructure", fingerprint: "evidence_failed" },
			usage: { requests, inputTokens: null, outputTokens: null, cost: null },
		}
		const { operations, reports, events } = harness([observed])
		operations.preserveEvidence = async () => {
			throw new Error("incomplete capture")
		}
		const report = await runCampaign(config(), operations)
		assert.equal(report.stopReason, "evidence_failed")
		assert.equal(report.usage.requests, requests)
		assert.equal(reports.at(-1)?.usage.requests, requests)
		assert.equal(report.attempts[0]?.result.usage.requests, requests)
		assert.equal(report.attempts[0]?.evidenceFailed, true)
		assert.equal(events.filter((event) => event.startsWith("run:")).length, 1)
	}
})

test("cancellation awaits scenario cleanup, then evidence, and launches nothing else", async () => {
	const abort = new AbortController()
	const { operations, events } = harness()
	operations.runScenario = async (_request, signal) => {
		abort.abort()
		assert.ok(signal.aborted)
		await Promise.resolve()
		events.push("cleanup")
		return result()
	}
	const report = await runCampaign(config(), operations, abort.signal)
	assert.equal(report.stopReason, "cancelled")
	assert.deepEqual(events, ["cleanup", "evidence:attempt-0001"])
})

test("pre-aborted campaign saves terminal report without launching", async () => {
	const { operations, events } = harness()
	const report = await runCampaign(config(), operations, AbortSignal.abort())
	assert.equal(report.stopReason, "cancelled")
	assert.deepEqual(events, [])
})

test("monotonic time budget expires between scenarios without extra launches", async () => {
	const { operations } = harness()
	let clock = 0
	operations.now = () => clock
	operations.preserveEvidence = async () => {
		clock = 60_000
		return "manifest.json"
	}
	const report = await runCampaign(config(), operations)
	assert.equal(report.stopReason, "time_budget")
	assert.equal(report.attempts.length, 1)
})

test("reviewed repair requires failed regression, preserves evidence, builds and verifies neighbors", async () => {
	const settings = config()
	settings.hosts = [{ version: "1.138.0" }]
	settings.scenarioIds = ["review"]
	settings.repair = {
		enabled: true,
		sourceRoot: "fixture",
		allowedPaths: ["src/example.ts"],
		plans: [
			{
				scenarioId: "review",
				diagnosisId: "receipt-loss",
				regressionScenarioId: "regression",
				neighborScenarioIds: ["cancel"],
				patch: { id: "fix-1", edits: [] },
			},
		],
	}
	const { operations, events } = harness([result("failed"), result("failed"), result("failed")])
	operations.applyPatch = async () => {
		events.push("patch")
		return { planId: "fix-1", files: [] }
	}
	operations.build = async () => {
		events.push("build")
		return true
	}
	const report = await runCampaign(settings, operations)
	assert.equal(report.stopReason, "completed")
	assert.equal(report.repairs[0]!.verified, true)
	assert.deepEqual(events, [
		"run:1.138.0:review:sample",
		"evidence:attempt-0001",
		"run:1.138.0:review:reproduce",
		"evidence:attempt-0002",
		"run:1.138.0:regression:regression-before",
		"evidence:attempt-0003",
		"patch",
		"build",
		"run:1.138.0:regression:verify-fix",
		"evidence:attempt-0004",
		"run:1.138.0:review:verify-fix",
		"evidence:attempt-0005",
		"run:1.138.0:cancel:neighbor",
		"evidence:attempt-0006",
	])
})

test("config parser rejects invalid budgets, duplicate hosts and implicit source repair", () => {
	assert.throws(() => parseCampaignConfig({ ...config(), budgets: { ...config().budgets, maxIterations: 0 } }))
	assert.throws(() => parseCampaignConfig({ ...config(), hosts: [{ version: "1.138.0" }, { version: "1.138.0" }] }))
	assert.throws(() => parseCampaignConfig({ ...config(), repair: { enabled: true } }))
	assert.throws(() => parseCampaignConfig({ ...config(), provider: { mode: "live-copilot" } }))
	assert.throws(() => parseCampaignConfig({ ...config(), id: "../user-profile" }))
	assert.deepEqual(parseCampaignConfig(config()), config())
	assert.deepEqual(parseCampaignConfig({ ...config(), storageBudget: {} }).storageBudget, {
		maxBytes: 10 * 1024 ** 3,
		maxEntries: 100_000,
		maxDepth: 32,
	})
	for (const storageBudget of [
		{ maxBytes: 101 * 1024 ** 3 },
		{ maxEntries: 1_000_001 },
		{ maxDepth: 33 },
		{ maxBytes: 0 },
	])
		assert.throws(() => parseCampaignConfig({ ...config(), storageBudget }))
})

test("late cancellation after a source publication preserves its receipt without building", async () => {
	const settings = config()
	settings.hosts = [{ version: "1.138.0" }]
	settings.scenarioIds = ["review"]
	settings.repair = {
		enabled: true,
		sourceRoot: "fixture",
		allowedPaths: ["src/example.ts"],
		plans: [
			{
				scenarioId: "review",
				diagnosisId: "late-cancel",
				regressionScenarioId: "regression",
				neighborScenarioIds: ["cancel"],
				patch: { id: "fix", edits: [] },
			},
		],
	}
	const abort = new AbortController()
	const { operations, events } = harness([result("failed"), result("failed"), result("failed")])
	operations.applyPatch = async () => {
		abort.abort()
		return {
			planId: "fix",
			files: [{ path: "src/example.ts", beforeSha256: "a".repeat(64), afterSha256: "b".repeat(64) }],
		}
	}
	operations.build = async () => {
		events.push("build")
		return true
	}
	const report = await runCampaign(settings, operations, abort.signal)
	assert.equal(report.stopReason, "cancelled")
	assert.equal(report.repairs[0]!.receipt.files.length, 1)
	assert.equal(report.repairs[0]!.verified, false)
	assert.ok(!events.includes("build"))
})
