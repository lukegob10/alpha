import { randomUUID } from "node:crypto"
import { mkdir, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { require as tsRequire } from "tsx/cjs/api"
import { lanes, selectLane } from "./catalog.mjs"
import { collectSource, comparableSource } from "./source.mjs"
import {
	aggregateReviewReports,
	AuditEvidenceError,
	codexReferenceSha,
	inspectCodexReference,
} from "./audit-evidence.mjs"
import { benchmarkVerdict, compareBenchmarks } from "./audit-benchmarks.mjs"
import { readExecutionJson } from "./execution-evidence.mjs"

const { rejectSymlinkComponents } = tsRequire("../../apps/vscode-e2e/src/evidence/paths.ts", import.meta.url)
const offlineLanes = ["static", "mechanical", "unit", "tooling", "offline", "admission", "performance", "benchmarks"]
const fullHostLanes = ["host", "extended", "managed", "minimum"]
const expensiveLanes = ["rendered", "stress", "confidence", "outcomes", "packaging"]

export function parseAuditArgs(args) {
	const options = {
		profile: "full",
		plan: false,
		expensive: false,
		services: false,
		infrastructure: false,
		timeoutMinutes: 180,
	}
	const seen = new Set()
	for (let index = 0; index < args.length; index++) {
		const key = args[index]
		if (seen.has(key)) throw new Error("Duplicate audit option")
		seen.add(key)
		if (["--plan", "--expensive", "--services", "--infrastructure"].includes(key)) options[key.slice(2)] = true
		else if (["--profile", "--codex-root", "--reports", "--baseline", "--timeout-minutes"].includes(key)) {
			const value = args[++index]
			if (!value || value.startsWith("--") || value.includes("\0"))
				throw new Error("Audit option requires a value")
			if (key === "--profile") options.profile = value
			else if (key === "--timeout-minutes") options.timeoutMinutes = Number(value)
			else {
				if (!path.isAbsolute(value)) throw new Error("Audit evidence inputs require absolute paths")
				options[{ "--codex-root": "codexRoot", "--reports": "reports", "--baseline": "baseline" }[key]] = value
			}
		} else throw new Error("Unknown audit option")
	}
	if (
		!["full", "offline", "performance"].includes(options.profile) ||
		!Number.isSafeInteger(options.timeoutMinutes) ||
		options.timeoutMinutes < 1 ||
		options.timeoutMinutes > 240
	)
		throw new Error("Choose full/offline/performance and a timeout from 1 to 240 minutes")
	if (options.profile !== "full" && (options.expensive || options.services || options.infrastructure))
		throw new Error("Host, service and container additions require the full profile")
	return options
}

export function auditPlan(options) {
	const selected = options.profile === "performance" ? ["performance", "benchmarks"] : [...offlineLanes]
	if (options.profile === "full") selected.push(...fullHostLanes)
	if (options.expensive) selected.push(...expensiveLanes)
	if (options.services) selected.push("services")
	if (options.infrastructure) selected.push("infrastructure")
	return {
		profile: options.profile,
		timeoutMinutes: options.timeoutMinutes,
		parallelLanes: 1,
		vitestWorkers: 2,
		lanes: selected.map((name) => ({
			name,
			commands: selectLane(name).commands,
			proves: lanes[name].proves,
			prerequisites: lanes[name].prerequisites ?? [],
		})),
		optional: [...fullHostLanes, ...expensiveLanes, "services", "infrastructure"].filter(
			(name) => !selected.includes(name),
		),
		evidence: {
			codexReference: { status: options.codexRoot ? "requested" : "unavailable", sha: codexReferenceSha },
			reviewReports: options.reports ? 30 : "unavailable",
			benchmarkComparison: options.baseline ? "requested" : "unavailable",
		},
		limits: [
			"No live-provider requests or external checkout fetches",
			"Source changes fail the run at boundaries",
			"Test passes, source references and review prose do not prove universal optimization or Codex equivalence",
			"Unselected, unavailable, cancelled and not-started coverage is not passing evidence",
		],
	}
}

/** Compose the canonical one-lane owner sequentially. Each lane acquires/releases its own existing build/host lease. */
export async function runAudit(args, { root, signal, runLane, source = collectSource, log = console.log }) {
	const options = parseAuditArgs(args)
	const plan = auditPlan(options)
	if (options.plan) {
		log(JSON.stringify(plan, null, 2))
		return 0
	}
	const directory = path.join(root, "artifacts/harness/.audits", `${Date.now()}-${randomUUID().slice(0, 8)}`)
	await rejectSymlinkComponents(directory)
	await mkdir(directory, { recursive: true, mode: 0o700 })
	const report = {
		schemaVersion: 1,
		kind: "alpha-repository-audit",
		status: "running",
		startedAt: new Date().toISOString(),
		plan,
		source: null,
		lanes: plan.lanes.map(({ name }) => ({ name, status: "not_started" })),
		alignment: { status: "unverified", reference: "unavailable" },
		reviews: { status: "unavailable" },
		benchmarkComparison: { status: "unavailable", reason: "no_matched_baseline_requested" },
	}
	const save = async () => {
		await writeFile(path.join(directory, "audit.json.tmp"), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 })
		await rename(path.join(directory, "audit.json.tmp"), path.join(directory, "audit.json"))
	}
	const deadline = new AbortController()
	const timer = setTimeout(() => deadline.abort("audit_timeout"), options.timeoutMinutes * 60_000)
	timer.unref()
	const executionSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
	let baseline
	let stage = "source"
	try {
		await save()
		report.source = await source(root)
		stage = "codex-reference"
		if (options.codexRoot) report.alignment.reference = await inspectCodexReference(root, options.codexRoot)
		stage = "review-reports"
		if (options.reports) report.reviews = await aggregateReviewReports(options.reports)
		stage = "benchmark-baseline"
		if (options.baseline) {
			try {
				baseline = await readExecutionJson(options.baseline, 1024 * 1024)
			} catch {
				throw new AuditEvidenceError("Benchmark baseline is missing, linked, oversized or invalid JSON")
			}
			if (benchmarkVerdict(baseline).status !== "passed")
				throw new AuditEvidenceError("Invalid benchmark baseline workload or measurements")
		}
		await save()
		for (const entry of report.lanes) {
			stage = entry.name
			if (executionSignal.aborted) break
			if (!comparableSource(report.source, await source(root))) {
				report.failure = { stage, code: "source_changed_during_audit" }
				throw new Error("Source changed before lane")
			}
			entry.status = "running"
			await save()
			const result = await runLane(entry.name, [], { signal: executionSignal, repository: root })
			Object.assign(entry, {
				status: result.report.status,
				report: path.relative(root, path.join(result.directory, "result.json")),
				cleanupVerified: result.report.cleanupUnverified !== true,
			})
			if (
				!comparableSource(report.source, result.report.source) ||
				!comparableSource(report.source, result.report.sourceAtEnd)
			) {
				report.failure = { stage, code: "source_changed_during_audit" }
				throw new Error("Source changed during audit lane")
			}
			if (entry.name === "benchmarks") {
				const measurements = result.report.steps.find((step) => step.evidence?.kind === "offline-benchmark")
					?.evidence.receipt
				if (baseline && measurements) report.benchmarkComparison = compareBenchmarks(baseline, measurements)
			}
			await save()
			if (entry.status !== "passed" || !entry.cleanupVerified) break
		}
		stage = "source-finalization"
		report.sourceAtEnd = await source(root)
		report.sourceUnchangedAtBoundaries = comparableSource(report.source, report.sourceAtEnd)
		report.status = executionSignal.aborted
			? "cancelled"
			: report.sourceUnchangedAtBoundaries && report.lanes.every((entry) => entry.status === "passed")
				? "passed"
				: "failed"
	} catch (error) {
		report.status = executionSignal.aborted ? "cancelled" : "failed"
		report.failure ??= { stage, code: "audit_execution_or_evidence_failed" }
		if (error instanceof AuditEvidenceError) report.failure.reason = error.message.slice(0, 256)
		const active = report.lanes.find((entry) => entry.status === "running")
		if (active) active.status = executionSignal.aborted ? "cancelled" : "failed"
	} finally {
		clearTimeout(timer)
		if (executionSignal.aborted)
			report.failure = { stage, code: deadline.signal.aborted ? "audit_timeout" : "audit_cancelled" }
		report.finishedAt = new Date().toISOString()
		await save()
	}
	log(
		JSON.stringify({
			status: report.status,
			report: path.join(directory, "audit.json"),
			alignment: "unverified",
			optional: plan.optional,
			benchmarkComparison: report.benchmarkComparison.status,
		}),
	)
	return report.status === "passed" ? 0 : signal?.reason === "SIGINT" ? 130 : signal?.reason === "SIGTERM" ? 143 : 1
}
