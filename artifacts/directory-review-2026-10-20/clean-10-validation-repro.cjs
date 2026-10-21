// Read-only production-code probes; no VS Code host, database, network, or model requests.
// Run from the repository root: node --require=tsx/cjs artifacts/directory-review-2026-10-20/clean-10-validation-repro.cjs
const assert = require("node:assert/strict")
const path = require("node:path")
const { createRequire } = require("node:module")
const { pathToFileURL } = require("node:url")

const root = path.resolve(__dirname, "../..")
const repoRequire = createRequire(path.join(root, "package.json"))
const e2eRequire = createRequire(path.join(root, "apps/vscode-e2e/package.json"))
const Mocha = e2eRequire("mocha")
const { readRunOptions } = repoRequire("./apps/vscode-e2e/src/runTest.ts")
const { testSuiteOutcome } = repoRequire("./apps/vscode-e2e/src/runFailure.ts")
const { evaluateFrontierConvergence } = repoRequire("./packages/evals/src/benchmark/convergence.ts")

async function main() {
	const options = readRunOptions(
		["--vscode-version", "1.138.0", "--provider", "scripted", "--require-all-tests", "--file", "extension.test"],
		{ TEST_GREP: "passing case" },
	)
	const mocha = new Mocha({ grep: options.testGrep, reporter: function () {} })
	mocha.suite.addTest(new Mocha.Test("passing case", () => {}))
	mocha.suite.addTest(new Mocha.Test("failing omitted case", () => { throw Error("must fail the gate") }))
	const filtered = await new Promise((resolve) => {
		const runner = mocha.run((failures) => resolve(testSuiteOutcome(failures, runner.stats, options)))
	})
	assert.equal(filtered.failure, undefined)
	assert.equal(filtered.counts.total, 1)
	const { hostSuiteVerdict, smokeHostFiles } = await import(pathToFileURL(path.join(root, "scripts/harness/host-evidence.mjs")))
	const { hostReceipt } = await import(pathToFileURL(path.join(root, "scripts/harness/fixtures/evidence.mjs")))
	const receiptVerdict = hostSuiteVerdict(smokeHostFiles.map(hostReceipt), "smoke")
	assert.equal(receiptVerdict.status, "passed")

	const missingMetrics = evaluateFrontierConvergence({
		harnessCertified: true, smokePassed: true, fullyPaired: true, predictedSegmentImproved: true, holdout: { total: 12 },
	})
	assert.equal(missingMetrics.promote, true)
	const malformedMetrics = evaluateFrontierConvergence({
		harnessCertified: "false", smokePassed: "false", fullyPaired: "false", predictedSegmentImproved: "false",
		criticalRegressions: "invalid", safetyFailures: "invalid", infrastructureErrorRate: "invalid",
		costPerSuccessIncrease: "invalid", p95LatencyIncrease: "invalid", holdout: { total: 12, safetyFailures: "invalid" },
	})
	assert.equal(malformedMetrics.promote, true)

	const events = []
	const stub = (file, exports) => {
		const id = repoRequire.resolve(file)
		require.cache[id] = { id, filename: id, loaded: true, exports }
	}
	stub("./packages/evals/src/db/index.ts", {
		findRun: async () => ({ id: 1, campaignHardCapUsd: null, taskCostCapUsd: null, taskMetricsId: null, concurrency: 1 }),
		getTasks: async () => [{ id: 1, finishedAt: null }],
		finishRun: async () => { events.push("finishRun"); return { id: 1, passed: 0, failed: 1 } },
		applyAttemptEvent: async () => {}, ensureAttempt: async () => {}, findTrialForTask: async () => {},
		getPresentationModelCallPolicyEvents: async () => [], settleTrialAfterRetries: async () => {}, updateTask: async () => {},
	})
	stub("./packages/evals/src/cli/processTask.ts", {
		processTask: async () => { events.push("host infrastructure rejected"); throw Error("host startup unavailable") },
		processTaskInContainer: async () => { throw Error("unexpected container") },
	})
	stub("./packages/evals/src/cli/redis.ts", { startHeartbeat: async () => 1, stopHeartbeat: async () => events.push("heartbeat stopped") })
	stub("./packages/evals/src/cli/utils.ts", {
		Logger: class { info() {} error() { events.push("error logged") } close() { events.push("logger closed") } },
		getTag: () => "repro", isDockerContainer: () => false, resetEvalsRepo: async () => {},
		commitEvalsRepoChanges: async () => events.push("commitEvalsRepoChanges"),
	})
	const { runEvals } = repoRequire("./packages/evals/src/cli/runEvals.ts")
	await runEvals(1)
	assert.ok(events.includes("host infrastructure rejected"))
	assert.ok(events.includes("finishRun"))
	console.log(JSON.stringify({
		exactHostSelection: { declared: 2, selected: options.testGrep, requireAllTests: options.requireAllTests, outcome: filtered, receiptSuite: receiptVerdict.status },
		frontierGate: { missingMetrics, malformedMetrics },
		legacyCi: { resolvedDespiteInfrastructureError: true, events },
	}, null, 2))
}

main().catch((error) => { console.error(error); process.exitCode = 1 })
