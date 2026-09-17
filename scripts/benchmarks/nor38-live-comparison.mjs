import * as fs from "node:fs/promises"
import { createReadStream } from "node:fs"
import * as path from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

// This arranges existing extension campaigns; it does not launch hosts or grade tasks itself.
const ORDER = ["baseline", "candidate", "candidate", "baseline", "baseline", "candidate"]
const SCENARIOS = ["dev-git-inspect", "review-edit-test-commit-followup", "long-thread"]
const CANDIDATE_BUNDLE = "6f99a0f370c45cc91e679bd709d3f312d53c2a148742a7b9519b84308e0beeee"
const PROVIDER = { mode: "live-copilot", modelId: "gpt-5.6-luna", effort: "high" }
const BUDGETS = { maxIterations: 3, maxRequests: 150, maxDurationMs: 1_200_000, attemptTimeoutMs: 600_000 }
const INPUTS = [
	"apps/vscode-e2e/fixtures",
	"apps/vscode-e2e/live-sidecar.package.json",
	"apps/vscode-e2e/package.json",
	"apps/vscode-e2e/tsconfig.json",
]
const PATH_OPTIONS = ["baseline-root", "candidate-root", "campaign-root", "profile-root", "host-executable"]
const emit = (event) => process.stdout.write(JSON.stringify(event) + "\n")

function parseOptions(argv) {
	const options = {}
	for (let index = 0; index < argv.length; index++) {
		const option = argv[index]
		if (option === "--dry-run" && !options.dryRun) options.dryRun = true
		else if (PATH_OPTIONS.includes(option?.slice(2)) && option.startsWith("--")) {
			const key = option.slice(2)
			const value = argv[++index]
			if (options[key] || !value || !path.isAbsolute(value) || value.includes("\0"))
				throw new Error(`Invalid absolute path option: ${option}`)
			options[key] = path.resolve(value)
		} else throw new Error("Unknown or duplicate comparison option")
	}
	if (PATH_OPTIONS.some((key) => !options[key])) throw new Error("All five explicit path options are required")
	return options
}

async function canonicalDirectory(directory) {
	const absolute = path.resolve(directory)
	const root = path.parse(absolute).root
	let current = root
	for (const segment of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
		current = path.join(current, segment)
		const stat = await fs.lstat(current)
		if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Directory contains a link or special entry")
	}
	return fs.realpath(absolute)
}

function within(parent, child) {
	const relative = path.relative(parent, child)
	return !relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
}

function overlaps(left, right) {
	return within(left, right) || within(right, left)
}

async function digestFile(file) {
	const stat = await fs.lstat(file)
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 ** 2)
		throw new Error("Invalid fingerprint input")
	const hash = createHash("sha256")
	for await (const chunk of createReadStream(file)) hash.update(chunk)
	return hash.digest("hex")
}

async function digestTree(root, inputs) {
	const hash = createHash("sha256")
	let entries = 0
	let bytes = 0
	const visit = async (relative) => {
		if (++entries > 10_000) throw new Error("Fingerprint entry limit exceeded")
		const absolute = path.join(root, relative)
		const stat = await fs.lstat(absolute)
		if (stat.isSymbolicLink()) throw new Error("Fingerprint input contains a link")
		hash.update(relative.replaceAll("\\", "/") + "\0")
		if (stat.isDirectory()) {
			for (const name of (await fs.readdir(absolute)).sort()) await visit(path.join(relative, name))
		} else if (stat.isFile()) {
			bytes += stat.size
			if (bytes > 512 * 1024 ** 2) throw new Error("Fingerprint byte limit exceeded")
			hash.update(String(stat.size) + "\0")
			for await (const chunk of createReadStream(absolute)) hash.update(chunk)
		} else throw new Error("Fingerprint input is not a regular file or directory")
	}
	for (const input of inputs) await visit(input)
	return { sha256: hash.digest("hex"), entries, bytes }
}

function loadHarness(root) {
	const require = createRequire(path.join(root, "apps/vscode-e2e/package.json"))
	const load = (relative) => require(path.join(root, "apps/vscode-e2e/out", relative))
	return {
		...load("campaign/config.js"),
		...load("campaign/controller.js"),
		...load("campaign/extensionAdapter.js"),
		...load("campaign/reportStore.js"),
		...load("campaign/liveGate.js"),
		...load("liveHostProtocol.js"),
	}
}

async function captureIdentity(root, api) {
	return {
		gateArtifacts: await api.fingerprintGateArtifacts(root),
		extensionBundle: await digestFile(path.join(root, "src/dist/extension.js")),
		harnessSource: await digestTree(root, ["apps/vscode-e2e/src"]),
		harnessCompiled: await digestTree(root, ["apps/vscode-e2e/out"]),
		fixtureAndBuildInputs: await digestTree(root, INPUTS),
	}
}

function requireMatchedHarness(identities) {
	for (const key of ["harnessSource", "harnessCompiled", "fixtureAndBuildInputs"])
		if (identities.baseline[key].sha256 !== identities.candidate[key].sha256)
			throw new Error(`Baseline and candidate differ in ${key}`)
	if (identities.candidate.extensionBundle !== CANDIDATE_BUNDLE)
		throw new Error("Candidate extension bundle differs from the declared Stage 1 artifact")
}

async function writeImmutable(directory, name, value) {
	const destination = path.join(directory, name)
	const temporary = path.join(directory, `.comparison-${randomUUID()}.tmp`)
	const handle = await fs.open(temporary, "wx", 0o600)
	try {
		await handle.writeFile(JSON.stringify(value, null, 2) + "\n")
		await handle.sync()
	} finally {
		await handle.close()
	}
	try {
		await fs.link(temporary, destination)
	} finally {
		await fs.unlink(temporary)
	}
	return destination
}

function stopReason(report) {
	if (report.stopReason !== "completed") return report.stopReason ?? "incomplete_report"
	if (report.retention?.status !== "complete") return "retention_failed"
	if (report.attempts.length !== SCENARIOS.length) return "incomplete_matrix"
	for (const attempt of report.attempts) {
		if (attempt.evidenceFailed || !attempt.evidence) return "evidence_failed"
		if (
			["infrastructure", "authentication", "usage_limit", "unsafe_repair"].includes(attempt.result.failure?.class)
		)
			return attempt.result.failure.class
		if (
			attempt.request.phase !== "sample" ||
			attempt.result.actualHostVersion !== "1.136.1" ||
			attempt.result.model?.id !== PROVIDER.modelId ||
			attempt.result.model?.effort !== PROVIDER.effort ||
			!Number.isSafeInteger(attempt.result.usage.requests) ||
			attempt.result.usage.requests <= 0
		)
			return "measurement_evidence_invalid"
	}
	return undefined
}

export async function main(argv = process.argv.slice(2)) {
	const options = parseOptions(argv)
	const roots = {
		baseline: await canonicalDirectory(options["baseline-root"]),
		candidate: await canonicalDirectory(options["candidate-root"]),
	}
	const profileRoot = await canonicalDirectory(options["profile-root"])
	const campaignPath = options["campaign-root"]
	if (
		overlaps(roots.baseline, roots.candidate) ||
		Object.values(roots).some((root) => overlaps(root, profileRoot) || overlaps(root, campaignPath)) ||
		within(profileRoot, campaignPath)
	)
		throw new Error("Source, campaign, and profile roots must have separate ownership")
	if (!(await fs.lstat(options["host-executable"])).isFile()) throw new Error("Host executable is not a file")
	const apis = { baseline: loadHarness(roots.baseline), candidate: loadHarness(roots.candidate) }
	const captureBoth = async () => ({
		baseline: await captureIdentity(roots.baseline, apis.baseline),
		candidate: await captureIdentity(roots.candidate, apis.candidate),
	})
	const id = `nor38-comparison-${new Date().toISOString().replace(/\D/g, "")}-${randomUUID().slice(0, 8)}`
	const blocks = ORDER.map((side, index) => ({
		side,
		config: apis[side].parseCampaignConfig({
			id: `${id}-b${index + 1}-${side}`,
			hosts: [{ version: "1.136.1", executable: options["host-executable"] }],
			scenarioIds: SCENARIOS,
			samples: 1,
			provider: PROVIDER,
			budgets: BUDGETS,
			maxReproductions: 1,
		}),
	}))
	const abort = new AbortController()
	const cancel = () => abort.abort()
	process.on("SIGINT", cancel)
	process.on("SIGTERM", cancel)
	let comparisonDirectory
	const results = []
	let reason
	let stoppedIdentity
	try {
		if (!options.dryRun) {
			// The fixed sidecar is prepared before freezing artifacts; no build runs here.
			for (const side of ["baseline", "candidate"]) {
				abort.signal.throwIfAborted()
				await apis[side].prepareLiveSidecar()
			}
		}
		const identities = await captureBoth()
		requireMatchedHarness(identities)
		const plan = {
			schemaVersion: 1,
			kind: "nor38-extension-performance-comparison",
			id,
			roots,
			profileRoot,
			identities,
			blocks,
			reproduceFailures: false,
			wrapperSha256: await digestFile(fileURLToPath(import.meta.url)),
			unavailableMetrics: ["providerCacheState", "inputTokens", "outputTokens", "cost", "timeToFirstToken"],
		}
		if (options.dryRun) {
			await apis.candidate.openCampaignRoot(campaignPath, false)
			emit({ event: "nor38-comparison-dry-run", status: "validated", plan })
			process.removeListener("SIGINT", cancel)
			process.removeListener("SIGTERM", cancel)
			return 0
		}
		const campaignRoot = await apis.candidate.openCampaignRoot(campaignPath, true)
		comparisonDirectory = (await apis.candidate.createReportStore(campaignRoot, id)).directory
		await writeImmutable(comparisonDirectory, "comparison-plan.json", plan)
		for (const block of blocks) {
			if (abort.signal.aborted) {
				reason = "cancelled"
				break
			}
			const before = await captureBoth()
			if (JSON.stringify(before) !== JSON.stringify(identities)) {
				reason = "artifact_or_source_drift"
				stoppedIdentity = before
				break
			}
			const api = apis[block.side]
			const store = await api.createReportStore(campaignRoot, block.config.id)
			await writeImmutable(store.directory, "block-plan.json", { ...block, before })
			let reportedAttempts = 0
			let checkpoint = 0
			let lastReport
			const operations = api.createExtensionCampaignOperations({
				config: block.config,
				campaignRoot,
				runDirectory: store.directory,
				profileRoot,
				repositoryRoot: roots[block.side],
				async persistReport(report) {
					await store.persistReport(report)
					lastReport = path.join(store.directory, `report-${String(++checkpoint).padStart(5, "0")}.json`)
					for (const attempt of report.attempts.slice(reportedAttempts))
						emit({
							event: "nor38-attempt-completed",
							side: block.side,
							campaignId: block.config.id,
							report: lastReport,
							attempt,
						})
					reportedAttempts = report.attempts.length
				},
			})
			let report
			let executionError
			try {
				// Awaiting this API also awaits its owned host/process cleanup after SIGINT.
				report = await api.runCampaign(block.config, operations, abort.signal, { reproduceFailures: false })
			} catch (error) {
				executionError = error instanceof Error ? error.message : "Unknown campaign failure"
				reason = abort.signal.aborted ? "cancelled" : "campaign_infrastructure_or_evidence_failure"
			}
			let after
			try {
				after = await captureBoth()
			} catch {
				reason ??= "artifact_fingerprint_unavailable"
			}
			const unchanged = Boolean(after) && JSON.stringify(after) === JSON.stringify(identities)
			reason ??= unchanged ? stopReason(report) : "artifact_or_source_drift"
			if (abort.signal.aborted) reason ??= "cancelled"
			const result = {
				side: block.side,
				campaignId: block.config.id,
				before,
				after: after ?? null,
				unchanged,
				report: lastReport ?? null,
				stopReason: reason ?? null,
				...(executionError ? { executionError } : {}),
			}
			const resultPath = await writeImmutable(store.directory, "block-result.json", result)
			results.push({ ...result, resultPath, counts: report?.counts ?? null, usage: report?.usage ?? null })
			emit({ event: "nor38-block-completed", ...results.at(-1) })
			if (reason) break
		}
	} catch (error) {
		reason = abort.signal.aborted ? "cancelled" : "comparison_infrastructure_or_evidence_failure"
		emit({
			event: "nor38-comparison-error",
			reason,
			detail: error instanceof Error ? error.message : "Unknown failure",
		})
	}
	const summary = {
		event: "nor38-comparison-result",
		id,
		status: reason ? "stopped" : "completed",
		stopReason: reason ?? "completed",
		plannedBlocks: blocks.length,
		attemptedBlocks: results.length,
		completedBlocks: results.filter((block) => block.stopReason === null).length,
		blocks: results,
		...(stoppedIdentity ? { stoppedIdentity } : {}),
		comparisonDirectory: comparisonDirectory ?? null,
		performanceVerdict: "not-computed",
	}
	try {
		if (comparisonDirectory) await writeImmutable(comparisonDirectory, "comparison-result.json", summary)
		emit(summary)
		return reason ? 2 : results.some((block) => block.counts.failed || block.counts.blocked) ? 1 : 0
	} finally {
		process.removeListener("SIGINT", cancel)
		process.removeListener("SIGTERM", cancel)
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main().then(
		(code) => {
			process.exitCode = code
		},
		(error) => {
			emit({
				event: "nor38-comparison-result",
				status: "stopped",
				stopReason: "preflight_or_evidence_failure",
				detail: error instanceof Error ? error.message : "Unknown failure",
			})
			process.exitCode = 2
		},
	)
}
