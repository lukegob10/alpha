#!/usr/bin/env node
import { spawnSync } from "node:child_process"
import { createHash, randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { lanes, selectLane } from "./catalog.mjs"
import { pnpmInvocation } from "./pnpm.mjs"
import { acquireBuildLease } from "./lease.mjs"
import { executeSteps } from "./steps.mjs"

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"))
const [action = "list", name, ...filters] = process.argv.slice(2)
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex")
const git = (...args) => {
	const result = spawnSync("git", args, { cwd: root, encoding: "utf8", windowsHide: true })
	return result.status === 0 ? result.stdout.trim() : null
}
async function save(directory, report) {
	await writeFile(path.join(directory, "result.json.tmp"), JSON.stringify(report, null, 2) + "\n")
	await rename(path.join(directory, "result.json.tmp"), path.join(directory, "result.json"))
	const lines = [
		`# ${report.lane}: ${report.status}`,
		"",
		report.proves,
		"",
		`Execution fidelity: ${report.fidelity}. Decision source: ${report.decisions}.`,
		"",
		`Source: ${report.source.commit ?? "unknown"}; dirty: ${report.source.dirty ?? "unknown"}.`,
		`Node: ${report.node}; pnpm: ${report.pnpm ?? "unknown"}.`,
		"",
		...report.steps.map((step) => `- ${step.command}: ${step.status}; exit ${step.exitCode ?? "unknown"}`),
		"",
		"Console output stays in the invoking terminal. This index contains no environment values or raw test logs.",
		"A running record after interruption is incomplete evidence. Passing this lane proves only the scope above.",
		"",
	]
	await writeFile(path.join(directory, "result.md"), lines.join("\n"))
}

let releaseBuildLease
let report
const abort = new AbortController()
const cancel = (signal) => abort.abort(signal)
const interrupt = () => cancel("SIGINT")
const terminate = () => cancel("SIGTERM")
process.on("SIGINT", interrupt)
process.on("SIGTERM", terminate)
try {
	if (action === "list") {
		console.log(JSON.stringify(lanes, null, 2))
	} else if (action === "doctor") {
		const pnpmPath = process.env.npm_execpath
		const invocation = pnpmPath ? pnpmInvocation(pnpmPath, ["--version"]) : null
		const version = invocation
			? spawnSync(invocation.executable, invocation.args, { encoding: "utf8" }).stdout?.trim()
			: null
		const result = {
			node: { expected: manifest.engines.node, actual: process.versions.node },
			pnpm: { expected: manifest.packageManager, actual: version ?? "invoke through pnpm harness" },
			services:
				"Optional: pnpm --filter @alpha-code/evals services:check. Offline and host lanes require no services or Docker.",
			host: "not probed; host lane checks actual VS Code 1.122.1",
			registry: "Uses pnpm/user registry configuration; credentials are never printed",
		}
		console.log(JSON.stringify(result, null, 2))
		if (process.versions.node !== manifest.engines.node || `pnpm@${version}` !== manifest.packageManager)
			process.exitCode = 1
	} else if (action === "run") {
		const lane = selectLane(name, filters)
		const pnpmPath = process.env.npm_execpath
		if (!pnpmPath || !/pnpm/i.test(pnpmPath)) throw new Error("Invoke with pnpm harness run <lane>")
		if (process.versions.node !== manifest.engines.node) throw new Error(`Use pinned Node ${manifest.engines.node}`)
		const invocation = pnpmInvocation(pnpmPath, ["--version"])
		const version = spawnSync(invocation.executable, invocation.args, { encoding: "utf8" }).stdout?.trim()
		if (`pnpm@${version}` !== manifest.packageManager) throw new Error(`Use ${manifest.packageManager}`)
		if (lane.exclusiveBuild) releaseBuildLease = await acquireBuildLease(root, name)
		const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`
		const directory = path.join(root, "artifacts", "harness", id)
		await mkdir(directory, { recursive: true })
		const status = git("status", "--porcelain")
		report = {
			schemaVersion: 1,
			id,
			lane: name,
			status: "running",
			startedAt: new Date().toISOString(),
			fidelity: lane.fidelity,
			decisions: lane.decisions,
			proves: lane.proves,
			prerequisites: lane.prerequisites ?? [],
			node: process.versions.node,
			pnpm: version,
			source: {
				commit: git("rev-parse", "HEAD"),
				dirty: status === null ? null : status.length > 0,
				lockfileSha256: hash(await readFile(path.join(root, "pnpm-lock.yaml"))),
			},
			steps: lane.commands.map((args) => ({
				command: `pnpm ${args.join(" ")}`,
				status: "not_started",
				exitCode: null,
			})),
		}
		console.log(`Local evidence: ${directory}`)
		await save(directory, report)
		await executeSteps({
			commands: lane.commands,
			root,
			pnpmPath,
			report,
			signal: abort.signal,
			save: (value) => save(directory, value),
		})
		process.exitCode =
			report.status === "passed" ? 0 : abort.signal.aborted ? (abort.signal.reason === "SIGINT" ? 130 : 143) : 1
	} else throw new Error("Usage: pnpm harness list | doctor | run <lane> [test paths]")
} catch (error) {
	console.error(error.message)
	process.exitCode = 1
} finally {
	process.removeListener("SIGINT", interrupt)
	process.removeListener("SIGTERM", terminate)
	if (releaseBuildLease && !report?.cleanupUnverified) await releaseBuildLease()
	else if (releaseBuildLease)
		console.error("Process cleanup is unverified; preserving the build/host lease for inspection.")
}
