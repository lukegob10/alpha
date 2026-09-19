#!/usr/bin/env node
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { mkdir, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { acquireBuildLease } from "./lease.mjs"
import { executeSteps } from "./steps.mjs"

const cases = new Set([
	"cancellation",
	"budgets",
	"nested-restart",
	"rendered-ui",
	"history-churn",
	"host-termination",
	"shared-workers",
])

export function parseLocalAcceptanceArgs(args) {
	const [scenario, ...rest] = args
	assert.ok(cases.has(scenario), `Choose one of: ${[...cases].join(", ")}`)
	const options = new Map()
	for (let index = 0; index < rest.length; index += 2) {
		const key = rest[index]
		const value = rest[index + 1]
		assert.ok(["--output", "--vscode-executable"].includes(key) && !options.has(key), "Unknown or duplicate option")
		assert.ok(value && path.isAbsolute(value) && !value.includes("\0"), "Options require absolute paths")
		options.set(key, value)
	}
	assert.equal(options.size, 2, "Both --output and --vscode-executable are required")
	return { scenario, output: path.resolve(options.get("--output")), executable: options.get("--vscode-executable") }
}

/** Release the build lease only when every launched host has a verified shutdown receipt. */
export function localAcceptanceHostsStopped(result) {
	if (result?.cleanupVerified === false) return false
	if (result?.leaseReleased !== undefined && !result.runs && !result.phases)
		return result.cleanupVerified === true && result.leaseReleased === true
	if (result?.phases && !result.runs)
		return (
			result.phases.length > 0 &&
			result.phases.every((phase) => phase.cleanupVerified === true && phase.leaseReleased === true)
		)
	const runs = result?.runs ?? (result?.host ? [result.host] : [result])
	return runs.length > 0 && runs.every((run) => run?.hostExitObserved === true)
}

export async function recordLocalAcceptanceFailure(report, stage, cleanupVerified, save) {
	if (!report) return
	report.status = "failed"
	report.failure = { stage, code: "local_acceptance_exception" }
	report.cleanupVerified = cleanupVerified
	report.finishedAt = new Date().toISOString()
	// Failure persistence must never replace the original driver error.
	await save().catch(() => undefined)
}

export function localAcceptanceExecution(result) {
	const runs = result?.runs ?? result?.phases ?? (result?.host ? [result.host] : [result])
	if (runs.some((run) => run?.execution === "test-seam")) return "test-seam"
	return runs.length > 0 && runs.every((run) => run?.execution === "extension-host") ? "extension-host" : "unverified"
}

export async function main(args = process.argv.slice(2)) {
	const options = parseLocalAcceptanceArgs(args)
	assert.equal((await stat(options.executable)).isFile(), true, "VS Code executable must be an existing file")
	const pnpmPath = process.env.npm_execpath
	assert.ok(pnpmPath && /pnpm/i.test(pnpmPath), "Invoke through pnpm harness:acceptance")
	const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")
	const release = await acquireBuildLease(root, `local-acceptance:${options.scenario}`)
	const abort = new AbortController()
	const interrupt = () => abort.abort()
	process.once("SIGINT", interrupt)
	process.once("SIGTERM", interrupt)
	let cleanupVerified = true
	let report
	let stage = "prepare"
	let primaryError
	const save = async () => writeFile(path.join(options.output, "result.json"), JSON.stringify(report, null, 2) + "\n")
	try {
		// Refuse reuse instead of overwriting an earlier success or failure.
		await mkdir(options.output, { mode: 0o700 })
		const commands = [
			["bundle"],
			["--filter", "@alpha-code/vscode-webview", "build"],
			["--filter", "@alpha-code/vscode-e2e", "compile"],
		]
		report = {
			schemaVersion: 1,
			startedAt: new Date().toISOString(),
			scenario: options.scenario,
			status: "running",
			liveRequests: 0,
			usageSource: "scripted-local-fixture",
			billingEvidence: "none",
			steps: commands.map((command) => ({ command: command.join(" "), status: "not_started" })),
		}
		stage = "build"
		await executeSteps({ commands, root, pnpmPath, report, signal: abort.signal, save })
		cleanupVerified = report.cleanupUnverified !== true
		if (report.status !== "passed") return 1
		report.status = "running"
		await save()
		const require = createRequire(import.meta.url)
		cleanupVerified = false
		stage = "host"
		let result
		if (options.scenario === "host-termination") {
			const {
				runHostTerminationCampaign,
			} = require("../../apps/vscode-e2e/out/campaign/hostTerminationCampaign.js")
			result = await runHostTerminationCampaign({
				fixtureRoot: path.join(options.output, "fixture"),
				host: { version: "1.122.1", executable: options.executable },
				signal: abort.signal,
			})
		} else if (options.scenario === "shared-workers") {
			const { runSharedStorageCampaign } = require("../../apps/vscode-e2e/out/campaign/sharedStorageCampaign.js")
			result = await runSharedStorageCampaign({
				fixtureRoot: path.join(options.output, "fixture"),
				host: { version: "1.122.1", executable: options.executable },
				signal: abort.signal,
				sharedWorkerMailbox: true,
			})
		} else if (options.scenario === "history-churn") {
			const {
				runTaskHistoryChurnCampaign,
			} = require("../../apps/vscode-e2e/out/campaign/taskHistoryChurnCampaign.js")
			result = await runTaskHistoryChurnCampaign({
				fixtureRoot: path.join(options.output, "fixture"),
				host: { version: "1.122.1", executable: options.executable },
				signal: abort.signal,
			})
		} else if (options.scenario === "nested-restart") {
			const { runNestedRestartCampaign } = require("../../apps/vscode-e2e/out/campaign/nestedRestartCampaign.js")
			result = await runNestedRestartCampaign({
				fixtureRoot: path.join(options.output, "fixture"),
				host: { version: "1.122.1", executable: options.executable },
				signal: abort.signal,
			})
		} else if (options.scenario === "rendered-ui") {
			const { runRenderedUiProbe } = require("../../apps/vscode-e2e/out/campaign/renderedUiProbe.js")
			result = await runRenderedUiProbe(options.executable, options.output, "acceptance", abort.signal)
		} else {
			const { runExtensionTests } = require("../../apps/vscode-e2e/out/runTest.js")
			const cancellation = options.scenario === "cancellation"
			result = await runExtensionTests({
				providerMode: "scripted",
				vscodeVersion: "1.122.1",
				vscodeExecutablePath: options.executable,
				profileDir: path.join(options.output, "profile"),
				workspace: path.join(options.output, "workspace"),
				artifactsDir: path.join(options.output, "evidence"),
				initializeProfile: true,
				runId: options.scenario,
				testFile: cancellation
					? "managed-agents.cancellation.acceptance.test"
					: "managed-agents.budget.acceptance.test",
				extensionTestsEnv: cancellation ? { ALPHA_E2E_CANCELLATION_RUN: "1" } : { ALPHA_E2E_BUDGET_RUN: "1" },
				retainEvidenceForCampaign: true,
				signal: AbortSignal.any([abort.signal, AbortSignal.timeout(240_000)]),
			})
		}
		cleanupVerified = localAcceptanceHostsStopped(result)
		report.result = result
		report.execution = localAcceptanceExecution(result)
		report.cleanupVerified = cleanupVerified
		report.status =
			!abort.signal.aborted &&
			result.status === "passed" &&
			cleanupVerified &&
			report.execution === "extension-host"
				? "passed"
				: "failed"
		report.finishedAt = new Date().toISOString()
		await save()
		console.log(`Local acceptance ${report.status}: ${options.output}`)
		return report.status === "passed" ? 0 : 1
	} catch (error) {
		primaryError = error
		await recordLocalAcceptanceFailure(report, stage, cleanupVerified, save)
		throw error
	} finally {
		process.removeListener("SIGINT", interrupt)
		process.removeListener("SIGTERM", interrupt)
		if (cleanupVerified) {
			try {
				await release()
			} catch (error) {
				if (!primaryError) throw error
			}
		} else console.error("Build/host lease retained: inspect owned host shutdown receipts before further builds.")
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	main()
		.then((code) => {
			process.exitCode = code
		})
		.catch((error) => {
			console.error(error.message)
			process.exitCode = 1
		})
}
