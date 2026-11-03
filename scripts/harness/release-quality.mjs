import { execFile } from "node:child_process"
import { appendFile } from "node:fs/promises"
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
	/^scripts\/harness\/release-quality(?:[.]|$)/u,
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

export async function releaseQualityCli(args, { root = process.cwd(), env = process.env } = {}) {
	const [action, ...flags] = args
	const options = new Map()
	for (let index = 0; index < flags.length; index += 2) {
		if (!["--candidate", "--run-id"].includes(flags[index]) || options.has(flags[index]) || !flags[index + 1])
			throw new Error("Invalid or duplicate release quality option")
		options.set(flags[index], flags[index + 1])
	}
	const candidate = options.get("--candidate")
	if (action === "policy" && !options.has("--run-id")) {
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
	if (action !== "verify-run" || !/^[1-9][0-9]{0,19}$/u.test(runId ?? "") || !sha(candidate))
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
