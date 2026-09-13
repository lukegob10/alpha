import * as fs from "node:fs/promises"
import * as path from "node:path"
import * as os from "node:os"
import { randomUUID } from "node:crypto"

import { prepareLiveGate, fingerprintGateArtifacts } from "./campaign/liveGate"
import { runOwnedProcess } from "./campaign/ownedProcess"
import { createReportStore, openCampaignRoot } from "./campaign/reportStore"
import { runExtensionTests, type ExtensionTestRunResult } from "./runTest"
import { readBounded } from "./evidence/paths"
import { testRunFailureCode } from "./runFailure"

/** Compose existing test and evidence owners; this runner never selects a live provider. */
export async function runCoreConfidence(
	repositoryRoot: string,
	pnpmCliPath: string | undefined,
	signal: AbortSignal,
	dependencies = { prepareLiveGate, fingerprintGateArtifacts, runExtensionTests, runOwnedProcess },
): Promise<number> {
	if (!pnpmCliPath || !path.isAbsolute(pnpmCliPath)) throw new Error("Run core confidence through pnpm")
	const root = await openCampaignRoot(path.join(repositoryRoot, "artifacts/core-confidence"), true)
	const id = `core-${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID().slice(0, 8)}`
	const { directory } = await createReportStore(root, id)
	// The existing profile owner deliberately rejects repository descendants. Keep all host state outside it.
	// Keep profile paths short enough for Git for Windows' default worktree checkout path limit.
	const hostDirectory = path.join(process.env.RUNNER_TEMP || os.tmpdir(), "alpha-core-confidence", id.slice(-8))
	const report: {
		schemaVersion: 1
		kind: string
		id: string
		status: "passed" | "failed"
		stage: string
		failure?: string
		hostEvidenceRoot: string
		liveRequests: 0
		artifactDigest?: string
		artifactsUnchanged?: boolean
		hosts: ExtensionTestRunResult[]
	} = {
		schemaVersion: 1,
		kind: "alpha-core-confidence",
		id,
		status: "failed",
		stage: "prepare",
		hostEvidenceRoot: path.join(hostDirectory, "runs"),
		liveRequests: 0,
		hosts: [],
	}
	const write = (name: string, value: unknown) =>
		fs.writeFile(path.join(directory, name), JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
	try {
		if (
			!(await dependencies.prepareLiveGate(
				repositoryRoot,
				pnpmCliPath,
				directory,
				signal,
				undefined,
				"regressions",
			))
		)
			return 1
		report.artifactDigest = await dependencies.fingerprintGateArtifacts(repositoryRoot, true)
		let completionEvidence: string | undefined
		for (const testFile of ["core-loop.test", "completion-idle.test", "managed-agents.acceptance.test"]) {
			signal.throwIfAborted()
			report.stage = testFile
			process.stdout.write(`Core confidence: ${testFile} on VS Code 1.122.1\n`)
			const result = await dependencies.runExtensionTests({
				signal: AbortSignal.any([signal, AbortSignal.timeout(10 * 60_000)]),
				vscodeVersion: "1.122.1",
				providerMode: "scripted",
				testFile,
				profileDir: path.join(hostDirectory, "p"),
				initializeProfile: true,
				workspace: path.join(hostDirectory, "workspaces", testFile),
				artifactsDir: path.join(hostDirectory, "runs"),
			})
			report.hosts.push(result)
			await write(`${testFile}-result.json`, result)
			if (
				result.status !== "passed" ||
				result.exitCode !== 0 ||
				result.actualVSCodeVersion !== "1.122.1" ||
				result.providerMode !== "scripted" ||
				result.execution !== "extension-host" ||
				!result.captureComplete ||
				result.retention?.status !== "complete"
			)
				return 1
			if (testFile === "completion-idle.test")
				completionEvidence = path.join(result.artifactsDir, "completion-idle.json")
		}
		if (!completionEvidence) return 1
		// Replay this run's real host projection in React; never borrow an older green capture from the environment.
		report.stage = "certify:managed-agents"
		const certificationSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)])
		const certification = await dependencies.runOwnedProcess(
			{
				executable: process.execPath,
				args: [pnpmCliPath, "certify:managed-agents"],
				cwd: repositoryRoot,
				env: { ...process.env, ALPHA_COMPLETION_IDLE_EVIDENCE: completionEvidence },
			},
			{ signal: certificationSignal, maxOutputBytes: 8 * 1024 * 1024 },
		)
		await write("certification-process.json", certification)
		if (certification.exitCode !== 0 || certification.signal !== null || certificationSignal.aborted) return 1
		const evidence = JSON.parse(
			(
				await readBounded(
					path.join(repositoryRoot, "artifacts/certification/managed-agent-milestone-evidence.json"),
					8 * 1024 * 1024,
				)
			).toString("utf8"),
		)
		await write("certification-evidence.json", evidence)
		if (
			evidence?.schemaVersion !== 1 ||
			evidence?.scope !== "deterministic-offline-only" ||
			evidence?.outcome?.status !== "PASS-DETERMINISTIC" ||
			evidence?.source?.stableDuringRun !== true
		)
			return 1
		report.stage = "artifact-stability"
		report.artifactsUnchanged =
			report.artifactDigest === (await dependencies.fingerprintGateArtifacts(repositoryRoot, true))
		if (!report.artifactsUnchanged) return 1
		report.status = "passed"
		report.stage = "completed"
		return 0
	} catch (error) {
		// Raw host/process diagnostics already live in bounded, owned evidence. Preserve the failing stage.
		report.failure = testRunFailureCode(error, "host-failed")
		return 1
	} finally {
		await write("gate-result.json", report)
		process.stdout.write(JSON.stringify({ ...report, resultPath: path.join(directory, "gate-result.json") }) + "\n")
	}
}

if (require.main === module) {
	const abort = new AbortController()
	const cancel = () => abort.abort()
	process.once("SIGINT", cancel)
	process.once("SIGTERM", cancel)
	runCoreConfidence(path.resolve(__dirname, "../../.."), process.env.npm_execpath, abort.signal)
		.then((code) => {
			process.exitCode = code
		})
		.catch(() => {
			process.stderr.write("Core confidence setup or evidence persistence failed.\n")
			process.exitCode = 1
		})
		.finally(() => {
			process.removeListener("SIGINT", cancel)
			process.removeListener("SIGTERM", cancel)
		})
}
