import { execFile } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFile, open, writeFile } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { promisify } from "node:util"

const execute = promisify(execFile)
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/u.test(value)
const ownRepository = (value) =>
	typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)
export const evidenceWorkflow = ".github/workflows/live-quality-evidence.yml"
const affectedPaths = [
	/^src\/(?:core\/(?:agent|task|tools|prompts|context-management|condense|task-persistence|auto-approval|webview)|api|integrations\/terminal)\//u,
	/^src\/shared\/(?:tools|api|modes|ExtensionMessage|WebviewMessage)\.ts$/u,
	/^packages\/types\/src\/(?:__tests__\/)?(?:agent|subagent|managed-agent|task|providers?|tool|model|mode|global-settings|goal-tool|vscode-extension-host)(?:[-./]|$)/u,
	/^apps\/vscode-e2e\/src\/(?:quality\/|run(?:Quality|Test|Evidence)\.ts$|suite\/(?:live-quality|harness-quality|live-file-tool-support|index)(?:[-.]|$))/u,
	/^apps\/vscode-e2e\/src\/scenarios\/requestBudget(?:[.]|$)/u,
	/^scripts\/evals\/proportional-scope-(?:compare|report)(?:[.]|$)/u,
	/^evals\/proportional-scope\//u,
	/^scripts\/harness\/release-(?:quality|evidence)(?:[.]|$)/u,
	/^\.github\/workflows\/(?:live-quality-evidence|release-vsix)\.yml$/u,
]

export const releaseQualityRequired = (paths) =>
	paths.some((file) => affectedPaths.some((pattern) => pattern.test(file)))

async function output(command, args, cwd) {
	const result = await execute(command, args, {
		cwd,
		encoding: "utf8",
		windowsHide: true,
		timeout: 30_000,
		maxBuffer: 8 * 1024 * 1024,
	})
	return result.stdout
}

/** Select the published ancestor, never a candidate's own tag or an unrelated recent release. */
export async function collectReleaseQualityPolicy(root, candidateSHA) {
	if (!sha(candidateSHA)) throw new Error("An exact release candidate SHA is required")
	let candidate, baseline, paths
	try {
		candidate = (await output("git", ["rev-parse", "--verify", `${candidateSHA}^{commit}`], root)).trim()
		const tag = (
			await output("git", ["describe", "--tags", "--match", "vsix-v*", "--abbrev=0", `${candidateSHA}^`], root)
		).trim()
		baseline = (await output("git", ["rev-parse", "--verify", `${tag}^{commit}`], root)).trim()
		paths = await output(
			"git",
			["diff", "--name-only", "--no-ext-diff", "--no-textconv", "--no-renames", "-z", baseline, candidate, "--"],
			root,
		)
	} catch {
		throw new Error("Release quality requires an existing candidate and an ancestral published vsix-v* baseline")
	}
	if (candidate !== candidateSHA || !sha(baseline)) throw new Error("Release quality commit identity is invalid")
	return { required: releaseQualityRequired(paths.split("\0").filter(Boolean)), baseline, candidate }
}

/** This establishes workflow provenance; submitted measurements remain captured facts, not authenticated attestations. */
export function validateEvidenceRun(run, { candidate, repository, runId } = {}) {
	if (!sha(candidate) || !ownRepository(repository))
		throw new Error("An exact candidate SHA and own repository are required")
	if (
		run?.status !== "completed" ||
		run.conclusion !== "success" ||
		run.event !== "workflow_dispatch" ||
		run.path !== evidenceWorkflow ||
		run.head_sha !== candidate ||
		run.repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
		run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() ||
		!Number.isSafeInteger(run.id) ||
		run.id <= 0 ||
		(runId !== undefined && String(run.id) !== runId)
	)
		throw new Error(
			"Live quality evidence must be a successful own-repository manual workflow at the candidate SHA",
		)
	return { runId: String(run.id), candidate, repository, workflow: evidenceWorkflow }
}

const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
const identifier = (value) => typeof value === "string" && /^[\w.-]{1,200}$/u.test(value)
const positive = (value) => Number.isSafeInteger(value) && value > 0

/** One reviewed real extension task is a smoke check, without a comparative quality or speed claim. */
export function validateLiveSmokeEvidence(value, { candidate } = {}) {
	if (!sha(candidate) || value?.reviewedForCandidate !== candidate)
		throw new Error("Live smoke evidence must be reviewed for the exact release candidate")
	const host = /^1\.(\d+)\.(\d+)$/u.exec(value.hostVersion ?? "")
	if (
		value.schemaVersion !== 1 ||
		value.kind !== "alpha-live-extension-smoke" ||
		value.status !== "passed" ||
		value.execution !== "extension-host" ||
		value.exitCode !== 0 ||
		value.hostExitObserved !== true ||
		value.ownershipGate !== "verified" ||
		value.captureComplete !== true ||
		value.completed !== 1 ||
		!positive(value.modelCalls) ||
		!positive(value.durationMs)
	)
		throw new Error("A successful captured real extension task with a live model request is required")
	if (
		!["live", "live-copilot"].includes(value.providerMode) ||
		!identifier(value.provider) ||
		["scripted", "fake-ai", "vscode-lm-fixture"].includes(value.provider) ||
		(value.providerMode === "live-copilot" && value.provider !== "live-copilot") ||
		typeof value.modelId !== "string" ||
		!value.modelId.trim() ||
		value.modelId.length > 200 ||
		typeof value.effort !== "string" ||
		!value.effort.trim() ||
		value.effort.length > 40 ||
		!identifier(value.runId) ||
		!identifier(value.fixtureId) ||
		typeof value.capturedAt !== "string" ||
		!Number.isFinite(Date.parse(value.capturedAt)) ||
		!host ||
		Number(host[1]) < 125 ||
		typeof value.reuseRecorded !== "boolean" ||
		!["manifest-inventory", "recorded-legacy"].includes(value.artifactBinding) ||
		(value.artifactBinding === "recorded-legacy" && !value.reuseRecorded) ||
		(value.observedSourceRevision !== null && !sha(value.observedSourceRevision)) ||
		!["run", "task", "manifest"].every((field) => digest(value.evidence?.[field]))
	)
		throw new Error("Live smoke requires recorded host, provider, model, time and artifact identities")
	if (value.hostVersion !== "1.141.0" && !value.reuseRecorded)
		throw new Error("A recorded pass from another supported host requires explicit reuse review")
	const fields = [
		"schemaVersion",
		"kind",
		"reviewedForCandidate",
		"reuseRecorded",
		"runId",
		"fixtureId",
		"capturedAt",
		"hostVersion",
		"providerMode",
		"provider",
		"modelId",
		"effort",
		"status",
		"execution",
		"exitCode",
		"completed",
		"modelCalls",
		"durationMs",
		"hostExitObserved",
		"ownershipGate",
		"captureComplete",
		"observedSourceRevision",
		"artifactBinding",
	]
	return {
		...Object.fromEntries(fields.map((field) => [field, value[field]])),
		evidence: Object.fromEntries(["run", "task", "manifest"].map((field) => [field, value.evidence[field]])),
	}
}

export async function readJson(file, limit = 64 * 1024) {
	const handle = await open(file, "r")
	try {
		const stat = await handle.stat()
		if (!stat.isFile() || stat.size > limit) throw new Error("Live smoke input exceeds its file bound")
		const buffer = Buffer.alloc(stat.size + 1)
		let length = 0
		while (length < buffer.length) {
			const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
			if (bytesRead === 0) break
			length += bytesRead
		}
		if (length !== stat.size) throw new Error("Live smoke input changed while being read")
		const bytes = buffer.subarray(0, length)
		return { value: JSON.parse(bytes.toString("utf8")), digest: createHash("sha256").update(bytes).digest("hex") }
	} finally {
		await handle.close()
	}
}

async function readSmokeRetentionFile(directory, name) {
	try {
		return (await readJson(path.join(directory, name))).value
	} catch (error) {
		if (error.code !== "ENOENT") throw new Error("Invalid live smoke retention evidence")
		return undefined
	}
}

async function requireCompleteSmokeRetention(directory, run, reuseRecorded) {
	const [retention, failure] = await Promise.all([
		readSmokeRetentionFile(directory, "retention-result.json"),
		readSmokeRetentionFile(directory, "retention-error.json"),
	])
	if (failure !== undefined) throw new Error("Live smoke retention failed")
	// A historical capture may predate retention sidecars. A current primary points to its required sidecar.
	if (retention === undefined && reuseRecorded && !Object.hasOwn(run, "retentionResultPath")) return
	if (
		retention?.schemaVersion !== 1 ||
		retention.runId !== run.runId ||
		retention.status !== "complete" ||
		retention.failure != null ||
		!["pending-release", "held"].includes(retention.eligibility)
	)
		throw new Error("Live smoke requires complete retention evidence for this run")
	if (retention.eligibility === "pending-release") {
		// The standalone runner writes a complete report before publishing the final inactivity marker.
		const inactive = await readSmokeRetentionFile(directory, ".retention-eligible.json")
		if (inactive?.kind !== "alpha-vscode-e2e-inactive" || inactive.version !== 1 || inactive.runId !== run.runId)
			throw new Error("Live smoke retention was not released for this run")
	}
}

/** Project existing finalized host evidence; never relabel its observed host or unknown source revision. */
async function captureLiveSmokeEvidence(directory, fixtureId, candidate, reuseRecorded) {
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/u.test(fixtureId ?? ""))
		throw new Error("A single fixture identifier is required")
	const files = ["run-result.json", `${fixtureId}.json`, "manifest.json"]
	const [run, task, manifest] = await Promise.all(
		files.map((file) => readJson(path.join(directory, file), 4 * 1024 * 1024)),
	)
	const metadata = manifest.value.metadata
	const taskEntry = manifest.value.artifacts?.find((artifact) => artifact.path === files[1])
	if (
		manifest.value.kind !== "alpha-vscode-e2e-run-evidence" ||
		manifest.value.finalized !== true ||
		manifest.value.captureComplete !== true ||
		manifest.value.runId !== run.value.runId ||
		metadata?.outcome !== "passed" ||
		metadata.provider !== run.value.providerMode ||
		metadata.hostVersion !== run.value.actualVSCodeVersion ||
		metadata.hostVersion !== task.value.hostVersion ||
		metadata.modelId !== task.value.model?.id ||
		metadata.reasoningEffort !== task.value.effort ||
		task.value.passed !== true ||
		(taskEntry ? taskEntry.sha256 !== task.digest : !reuseRecorded)
	)
		throw new Error("Live smoke task, model and finalized host artifacts do not match")
	await requireCompleteSmokeRetention(directory, run.value, reuseRecorded)
	// The live Copilot runner records Alpha's adapter name separately from the model vendor.
	const observedCopilot =
		run.value.providerMode === "live-copilot" &&
		task.value.providerMode === "live-copilot" &&
		task.value.provider === "vscode-lm" &&
		task.value.model?.vendor === "copilot" &&
		run.value.providerIdentity?.status === "unchanged"
	return validateLiveSmokeEvidence(
		{
			schemaVersion: 1,
			kind: "alpha-live-extension-smoke",
			reviewedForCandidate: candidate,
			reuseRecorded,
			runId: run.value.runId,
			fixtureId,
			capturedAt: metadata.finishedAt,
			hostVersion: run.value.actualVSCodeVersion,
			providerMode: run.value.providerMode,
			provider: observedCopilot ? "live-copilot" : task.value.provider,
			modelId: task.value.model.id,
			effort: task.value.effort,
			status: run.value.status,
			execution: run.value.execution,
			exitCode: run.value.exitCode,
			completed: task.value.completed,
			modelCalls: task.value.requests,
			durationMs: task.value.elapsedMs,
			hostExitObserved: run.value.hostExitObserved,
			ownershipGate: run.value.ownershipGate,
			captureComplete: run.value.captureComplete,
			observedSourceRevision: metadata.sourceRevision ?? null,
			artifactBinding: taskEntry ? "manifest-inventory" : "recorded-legacy",
			evidence: { run: run.digest, task: task.digest, manifest: manifest.digest },
		},
		{ candidate },
	)
}

async function exportSmoke(options) {
	const candidate = options.get("--candidate")
	const allowed = [
		"--candidate",
		"--input",
		"--output",
		"--validated-bundle",
		"--dispatch-input",
		"--run-dir",
		"--fixture",
		"--reuse-recorded",
	]
	if ([...options.keys()].some((key) => !allowed.includes(key)) || !options.get("--output"))
		throw new Error("Live smoke requires an output and only smoke options")
	const input = options.get("--input")
	const directory = options.get("--run-dir")
	if (
		Boolean(input) === Boolean(directory) ||
		(input && ["--fixture", "--reuse-recorded"].some((key) => options.has(key)))
	)
		throw new Error("Choose a captured run directory or an existing portable smoke report")
	if (options.has("--reuse-recorded") && !["true", "false"].includes(options.get("--reuse-recorded")))
		throw new Error("Recorded live smoke reuse must be explicitly true or false")
	const result = directory
		? await captureLiveSmokeEvidence(
				directory,
				options.get("--fixture"),
				candidate,
				options.get("--reuse-recorded") === "true",
			)
		: validateLiveSmokeEvidence((await readJson(input)).value, { candidate })
	const serialized = JSON.stringify(result, null, 2) + "\n"
	const dispatch = JSON.stringify({ reports: JSON.stringify(result) }) + "\n"
	if (Buffer.byteLength(dispatch, "utf8") > 65_535) throw new Error("Live smoke workflow input exceeds its bound")
	await writeFile(options.get("--output"), serialized, { flag: "wx", mode: 0o600 })
	if (options.has("--validated-bundle"))
		await writeFile(options.get("--validated-bundle"), serialized, { flag: "wx", mode: 0o600 })
	if (options.has("--dispatch-input"))
		await writeFile(options.get("--dispatch-input"), dispatch, { flag: "wx", mode: 0o600 })
	return result
}

export async function releaseQualityCli(args, { root = process.cwd(), env = process.env } = {}) {
	const [action, ...flags] = args
	const options = new Map()
	for (let index = 0; index < flags.length; index += 2) {
		if (
			!flags[index]?.startsWith("--") ||
			options.has(flags[index]) ||
			!flags[index + 1] ||
			flags[index + 1].startsWith("--")
		)
			throw new Error("Invalid or duplicate release quality option")
		options.set(flags[index], flags[index + 1])
	}
	const candidate = options.get("--candidate")
	if (action === "verify-smoke") return exportSmoke(options)
	if (action === "policy" && options.size === 1) {
		const policy = await collectReleaseQualityPolicy(root, candidate)
		if (env.GITHUB_OUTPUT)
			await appendFile(
				env.GITHUB_OUTPUT,
				Object.entries(policy)
					.map(([key, value]) => `${key}=${value}\n`)
					.join(""),
			)
		return policy
	}
	const runId = options.get("--run-id")
	if (action !== "verify-run" || options.size !== 2 || !/^[1-9][0-9]{0,19}$/u.test(runId ?? "") || !sha(candidate))
		throw new Error("Expected policy --candidate SHA or verify-run --run-id ID --candidate SHA")
	const repository = env.GITHUB_REPOSITORY
	if (!ownRepository(repository)) throw new Error("An own GITHUB_REPOSITORY is required")
	const run = JSON.parse(await output("gh", ["api", `repos/${repository}/actions/runs/${runId}`], root))
	return validateEvidenceRun(run, { candidate, repository, runId })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	releaseQualityCli(process.argv.slice(2))
		.then((result) => console.log(JSON.stringify(result)))
		.catch((error) => {
			console.error(error.message)
			process.exitCode = 1
		})
