import { createHash } from "node:crypto"
import { mkdtemp, realpath } from "node:fs/promises"
import { createRequire } from "node:module"
import os from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { hostSuiteVerdict, validateHostReceipt } from "./host-evidence.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))
export const stressCases = [
	{ testFile: "managed-agents.cancellation.acceptance.test", env: { ALPHA_E2E_CANCELLATION_RUN: "1" } },
	{ testFile: "managed-agents.budget.acceptance.test", env: { ALPHA_E2E_BUDGET_RUN: "1" } },
]

export function loadHostProbeDrivers(
	repositoryRoot,
	requireModule = createRequire(path.join(repositoryRoot, "apps/vscode-e2e/package.json")),
) {
	// Source imports would make the canonical runner select src/suite/index instead of the compiled host entrypoint.
	const { runExtensionTests } = requireModule(path.join(repositoryRoot, "apps/vscode-e2e/out/runTest.js"))
	const { runRenderedUiProbe } = requireModule(
		path.join(repositoryRoot, "apps/vscode-e2e/out/campaign/renderedUiProbe.js"),
	)
	if (typeof runExtensionTests !== "function" || typeof runRenderedUiProbe !== "function")
		throw new Error("Compile the existing E2E host owners before selecting host probes")
	return { runExtensionTests, runRenderedUiProbe }
}

/** Project only observed host state; requested flags alone cannot establish complete execution. */
export function probeHostReceipt(result, testFile, startedAt, completedAt) {
	const receipt = validateHostReceipt({
		...result,
		schemaVersion: 1,
		kind: "alpha-extension-test-run",
		testFile,
		startedAt,
		completedAt,
		requestedHostVersion: "1.138.0",
		actualHostVersion: result.actualVSCodeVersion,
		retentionStatus: result.retention?.status,
		profile: {
			kind: result.profileDir ? "persistent" : "disposable",
			sha256: createHash("sha256").update(result.userDataDir).digest("hex"),
		},
	})
	if (
		receipt.testSelection?.testFile !== testFile ||
		receipt.testSelection.grep !== null ||
		receipt.testSelection.forbidOnly !== true
	)
		throw new Error("Incomplete host selection receipt")
	return receipt
}

/** Select existing drivers serially; their runner remains the owner of activation, policy and process cleanup. */
export async function runHostProbes(mode, { directory, executable, signal }, dependencies) {
	if (!["stress", "rendered-acceptance"].includes(mode)) throw new Error("Unknown host probe selection")
	if (!path.isAbsolute(directory) || !path.isAbsolute(executable))
		throw new Error("Host probe paths must be absolute")
	const bounded = AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)])
	const receipts = []
	bounded.throwIfAborted()
	if (mode === "rendered-acceptance") {
		const startedAt = new Date().toISOString()
		const result = await dependencies.runRenderedUiProbe(executable, directory, "acceptance", bounded)
		if (result.status !== "passed") throw new Error("Rendered acceptance did not pass")
		receipts.push(
			probeHostReceipt(result.host, "managed-agents.acceptance.test", startedAt, new Date().toISOString()),
		)
	} else {
		for (const [index, scenario] of stressCases.entries()) {
			bounded.throwIfAborted()
			const startedAt = new Date().toISOString()
			const result = await dependencies.runExtensionTests({
				providerMode: "scripted",
				vscodeVersion: "1.138.0",
				vscodeExecutablePath: executable,
				testFile: scenario.testFile,
				requireAllTests: true,
				profileDir: path.join(directory, `profile-${index}`),
				workspace: path.join(directory, `workspace-${index}`),
				artifactsDir: path.join(directory, `evidence-${index}`),
				initializeProfile: true,
				retainEvidenceForCampaign: true,
				extensionTestsEnv: scenario.env,
				signal: AbortSignal.any([bounded, AbortSignal.timeout(240_000)]),
			})
			receipts.push(probeHostReceipt(result, scenario.testFile, startedAt, new Date().toISOString()))
		}
		if (hostSuiteVerdict(receipts, "stress").status !== "passed") throw new Error("Stress host suite is incomplete")
	}
	bounded.throwIfAborted()
	return { status: "passed", mode, liveRequests: 0, receipts }
}

async function main(args) {
	if (args.length !== 1 || !["stress", "rendered-acceptance"].includes(args[0]))
		throw new Error("Choose stress or rendered-acceptance")
	const require = createRequire(path.join(root, "apps/vscode-e2e/package.json"))
	const drivers = loadHostProbeDrivers(root, require)
	const { downloadAndUnzipVSCode } = require("@vscode/test-electron")
	const executable = await downloadAndUnzipVSCode({ version: "1.138.0" })
	const temporaryRoot = await realpath(process.env.RUNNER_TEMP || os.tmpdir())
	const directory = await mkdtemp(path.join(temporaryRoot, "alpha-harness-host-probes-"))
	const abort = new AbortController()
	const interrupt = () => abort.abort()
	process.once("SIGINT", interrupt)
	process.once("SIGTERM", interrupt)
	try {
		const result = await runHostProbes(args[0], { directory, executable, signal: abort.signal }, drivers)
		console.log(JSON.stringify({ status: result.status, mode: result.mode, liveRequests: 0, directory }))
	} finally {
		process.removeListener("SIGINT", interrupt)
		process.removeListener("SIGTERM", interrupt)
	}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
	main(process.argv.slice(2)).catch(() => {
		console.error("Owned host probes failed; inspect the retained host receipts before another run")
		process.exitCode = 1
	})
