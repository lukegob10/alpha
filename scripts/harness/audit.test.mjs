import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { auditPlan, parseAuditArgs, runAudit } from "./audit.mjs"
import { aggregateReviewReports, validateReviewReport } from "./audit-evidence.mjs"
import { benchmarkEntries, benchmarkVerdict, collectBenchmarks, compareBenchmarks } from "./audit-benchmarks.mjs"
import { benchmarkReceipt, reviewReport } from "./fixtures/audit.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
const identity = { commit: "a".repeat(40), dirty: true, treeSha256: "a".repeat(64), lockfileSha256: "a".repeat(64) }

async function temporary(operation) {
	const directory = await mkdtemp(path.join(await realpath(os.tmpdir()), "alpha-audit-test-"))
	try {
		return await operation(directory)
	} finally {
		assert.ok(path.basename(directory).startsWith("alpha-audit-test-"))
		await rm(directory, { recursive: true, force: true })
	}
}

test("full audit retains mechanical owners, exact hosts, managed automated and explicit optional scope", () => {
	const plan = auditPlan(parseAuditArgs([]))
	assert.deepEqual(
		plan.lanes.map(({ name }) => name),
		[
			"static",
			"mechanical",
			"unit",
			"tooling",
			"offline",
			"admission",
			"performance",
			"benchmarks",
			"host",
			"extended",
			"managed",
			"minimum",
		],
	)
	assert.deepEqual(plan.lanes.find(({ name }) => name === "managed").commands, [["certify:managed-agents:automated"]])
	assert.deepEqual(plan.lanes.find(({ name }) => name === "minimum").commands, [
		["--filter", "@alpha-code/vscode-e2e", "test:compatibility:1250"],
	])
	assert.equal(plan.parallelLanes, 1)
	assert.equal(plan.vitestWorkers, 2)
	assert.ok(plan.optional.includes("services") && plan.optional.includes("packaging"))
	const offline = auditPlan(parseAuditArgs(["--profile", "offline"]))
	assert.ok(
		!offline.lanes.some(({ name }) =>
			["host", "extended", "minimum", "managed", "services", "infrastructure"].includes(name),
		),
	)
	const expensive = auditPlan(parseAuditArgs(["--expensive"]))
	assert.ok(expensive.lanes.some(({ name, commands }) => name === "packaging" && commands[2][3].endsWith(".vsix")))
})

test("audit arguments reject undeclared, repeated, unbounded and implicit external inputs", () => {
	for (const args of [
		["--profile", "live"],
		["--timeout-minutes", "241"],
		["--timeout-minutes", "0"],
		["--timeout-minutes", "1.5"],
		["--reports", "relative"],
		["--plan", "--plan"],
		["--unknown"],
		["--profile", "offline", "--expensive"],
		["--profile", "performance", "--services"],
	])
		assert.throws(() => parseAuditArgs(args))
})

test("audit plan performs no execution, source capture or artifact write", async () => {
	await temporary(async (directory) => {
		const output = []
		assert.equal(
			await runAudit(["--plan"], {
				root: directory,
				log: (value) => output.push(value),
				source: () => assert.fail("must not capture source"),
				runLane: () => assert.fail("must not execute"),
			}),
			0,
		)
		assert.equal(JSON.parse(output[0]).profile, "full")
		assert.deepEqual(await readdir(directory), [])
	})
})

async function auditFixture(directory, runLane, signal, source = async () => identity) {
	const output = []
	const code = await runAudit(["--profile", "performance"], {
		root: directory,
		signal,
		source,
		log: (value) => output.push(value),
		runLane,
	})
	const summary = JSON.parse(output[0])
	return { code, summary, report: JSON.parse(await readFile(summary.report, "utf8")) }
}
const laneResult = (directory, name, status = "passed") => ({
	directory: path.join(directory, name),
	report: { status, source: identity, sourceAtEnd: identity, steps: [] },
})

test("audit invokes the existing one-lane owner serially without a surrounding lease and links receipts", async () => {
	await temporary(async (directory) => {
		const calls = []
		let active = 0
		const { code, report } = await auditFixture(directory, async (name, filters, options) => {
			assert.equal(++active, 1)
			assert.deepEqual(filters, [])
			assert.equal(options.repository, directory)
			assert.ok(options.signal instanceof AbortSignal)
			calls.push(name)
			active--
			return laneResult(directory, name)
		})
		assert.equal(code, 0)
		assert.deepEqual(calls, ["performance", "benchmarks"])
		assert.equal(report.sourceUnchangedAtBoundaries, true)
		assert.equal(report.alignment.status, "unverified")
		assert.equal(report.lanes[0].report, path.join("performance", "result.json"))
	})
})

test("failures, cleanup uncertainty and cancellation never start subsequent lanes", async () => {
	for (const scenario of ["failed", "cleanup", "cancelled", "exception"])
		await temporary(async (directory) => {
			const abort = new AbortController()
			const calls = []
			const { code, report } = await auditFixture(
				directory,
				async (name) => {
					calls.push(name)
					if (scenario === "exception") throw new Error("PRIVATE_RAW_PROCESS_OUTPUT")
					if (scenario === "cancelled") abort.abort("SIGINT")
					const result = laneResult(directory, name, scenario === "failed" ? "failed" : "passed")
					if (scenario === "cleanup") result.report.cleanupUnverified = true
					return result
				},
				abort.signal,
			)
			assert.equal(code, scenario === "cancelled" ? 130 : 1)
			assert.deepEqual(calls, ["performance"])
			assert.equal(report.lanes[1].status, "not_started")
			assert.equal(JSON.stringify(report).includes("PRIVATE_RAW_PROCESS_OUTPUT"), false)
		})
})

test("source edits with the same dirty flag invalidate the whole audit before launching another lane", async () => {
	await temporary(async (directory) => {
		let captures = 0
		const { code, report } = await auditFixture(
			directory,
			() => assert.fail("changed source must not launch"),
			undefined,
			async () => ({ ...identity, treeSha256: (++captures === 1 ? "a" : "b").repeat(64) }),
		)
		assert.equal(code, 1)
		assert.equal(report.status, "failed")
		assert.ok(report.lanes.every((lane) => lane.status === "not_started"))
	})
})

test("optional evidence failures retain actionable fixed context without copying unknown error content", async () => {
	await temporary(async (directory) => {
		const reports = path.join(directory, "reports")
		await mkdir(reports)
		const output = []
		assert.equal(
			await runAudit(["--profile", "performance", "--reports", reports], {
				root: directory,
				source: async () => identity,
				log: (value) => output.push(value),
				runLane: () => assert.fail("invalid evidence must not execute"),
			}),
			1,
		)
		const report = JSON.parse(await readFile(JSON.parse(output[0]).report, "utf8"))
		assert.equal(report.failure.stage, "review-reports")
		assert.match(report.failure.reason, /exactly reports 01.json through 30.json/)
		assert.ok(report.failure.reason.length <= 256)
	})
})

test("thirty reports are complete bounded review evidence and cannot become alignment passes", async () => {
	await temporary(async (directory) => {
		for (let index = 1; index <= 30; index++) {
			const agent = String(index).padStart(2, "0")
			await writeFile(path.join(directory, `${agent}.json`), JSON.stringify(reviewReport(agent)))
		}
		const result = await aggregateReviewReports(directory)
		assert.equal(result.count, 30)
		assert.equal(result.kind, "review-evidence-only")
		assert.ok(result.reports.every((report) => /^[a-f0-9]{64}$/.test(report.sha256)))
		await writeFile(path.join(directory, "30.json"), JSON.stringify(reviewReport("29")))
		await assert.rejects(aggregateReviewReports(directory), /Invalid review report/)
		await writeFile(path.join(directory, "30.json"), "x".repeat(256 * 1024 + 1))
		await assert.rejects(aggregateReviewReports(directory), /limit/)
		await rm(path.join(directory, "30.json"))
		await assert.rejects(aggregateReviewReports(directory), /exactly/)
	})
})

test("report validation permits measured structured baselines but rejects missing fields and oversized findings", () => {
	const value = reviewReport()
	value.upstream.alignment = ["Adapter-specific"]
	value.findings.push({
		id: "01-01",
		severity: "Low",
		priority: "advisory",
		file: "src/fixture.ts",
		line: 1,
		invariant: "fixture invariant",
		evidence: ["counter observation"],
		performance: { metric: "reads", workload: "fixed fixture", baseline: { count: 2 }, command: "fixture command" },
		smallestFix: "bounded fix",
		regressionTest: "observable contract",
		confidence: 0.9,
	})
	assert.equal(validateReviewReport(value, "01"), value)
	const invalid = structuredClone(value)
	delete invalid.findings[0].regressionTest
	assert.throws(() => validateReviewReport(invalid, "01"))
	value.findings = Array(4).fill(value.findings[0])
	assert.throws(() => validateReviewReport(value, "01"))
})

test("linked evidence paths cannot smuggle foreign report sets into aggregation", async () => {
	await temporary(async (directory) => {
		const actual = path.join(directory, "actual")
		await mkdir(actual)
		const linked = path.join(directory, "linked")
		await symlink(actual, linked, process.platform === "win32" ? "junction" : "dir")
		await assert.rejects(aggregateReviewReports(linked), /contains links/)
	})
})

test("default benchmark loader resolves transitive extensionless TypeScript from CommonJS and ESM roots with spaces and hash characters", async () => {
	const expected = await benchmarkReceipt(root)
	await temporary(async (directory) => {
		for (const type of ["commonjs", "module"]) {
			const fixtureRoot = path.join(directory, `real benchmark # fixture ${type}`)
			await mkdir(fixtureRoot)
			await writeFile(path.join(fixtureRoot, "package.json"), JSON.stringify({ type }))
			for (const [index, entry] of benchmarkEntries.entries()) {
				const file = path.join(fixtureRoot, entry)
				await mkdir(path.dirname(file), { recursive: true })
				await writeFile(
					path.join(path.dirname(file), "fixture-measurement.ts"),
					`export const measurement: unknown = ${JSON.stringify(expected.workloads[index].measurements)}\n`,
				)
				await writeFile(
					file,
					`import { measurement } from "./fixture-measurement"\nconsole.log(JSON.stringify(measurement))\n`,
				)
			}
			const actual = await collectBenchmarks(fixtureRoot)
			assert.equal(benchmarkVerdict(actual).status, "passed")
			assert.deepEqual(
				actual.workloads.map(({ measurements }) => measurements),
				expected.workloads.map(({ measurements }) => measurements),
			)
		}
	})
})

test("existing benchmark adapters retain fixed workload samples and reject hidden none-fork history reads", async () => {
	const receipt = await benchmarkReceipt(root)
	assert.deepEqual(
		receipt.workloads.map(({ entry }) => entry),
		benchmarkEntries,
	)
	assert.equal(benchmarkVerdict(receipt).status, "passed")
	for (const mutate of [
		(value) => value.workloads[0].measurements.samplesMs.pop(),
		(value) => value.workloads[1].measurements.observations.pop(),
		(value) => value.workloads[1].measurements.observations[2].contentReads++,
		(value) => (value.workloads[1].measurements.observations[0].medianCaptureMs = Infinity),
	]) {
		const invalid = structuredClone(receipt)
		mutate(invalid)
		assert.equal(benchmarkVerdict(invalid).status, "failed")
	}
	assert.equal(compareBenchmarks(receipt, receipt).status, "diagnostic-comparison")
	const unmatched = structuredClone(receipt)
	unmatched.cpu += " different"
	assert.equal(compareBenchmarks(receipt, unmatched).status, "unavailable")
	const previous = console.log
	await assert.rejects(
		collectBenchmarks(root, async () => {
			throw new Error("fixture failure")
		}),
		/fixture failure/,
	)
	assert.equal(console.log, previous)
})
