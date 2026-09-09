import * as path from "node:path"
import * as fs from "node:fs/promises"
import { randomUUID } from "node:crypto"

import { parseCampaignConfig } from "./campaign/config"
import { createDevelopmentSuite } from "./campaign/developmentSuites"
import { runCampaign } from "./campaign/controller"
import { createExtensionCampaignOperations } from "./campaign/extensionAdapter"
import { createReportStore, openCampaignRoot } from "./campaign/reportStore"
import { runStorageRecoveryCampaign } from "./campaign/storageRecoveryCampaign"
import { runSharedStorageCampaign } from "./campaign/sharedStorageCampaign"
import { assertLiveGateConfig, evaluateLiveGate, fingerprintGateArtifacts, prepareLiveGate } from "./campaign/liveGate"
import { HOST_VERSIONS, type CampaignConfig, type CampaignHost, type CampaignReport } from "./campaign/types"
import { assertSafeRoot, readBounded } from "./evidence/paths"
import { prepareLiveSidecar } from "./liveHostProtocol"

export function campaignExitCode(report: CampaignReport): number {
	if (report.stopReason !== "completed") return 2
	if (report.retention && report.retention.status !== "complete") return 2
	// Completing the matrix does not erase observed failures, including historical repaired failures.
	return report.counts.failed > 0 || report.counts.blocked > 0 ? 1 : 0
}

export function resolveCampaignProfileRoot(campaignRoot: string, profileDir?: string): string {
	if (profileDir !== undefined && (!path.isAbsolute(profileDir) || profileDir.includes("\0")))
		throw new Error("Campaign profile directory must be an absolute path")
	// Marker, profile ownership and normal-user-data exclusions remain the existing runner's responsibility.
	return profileDir ?? path.join(campaignRoot, "profiles")
}

async function withProcessSignals<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
	const abort = new AbortController()
	const onSignal = () => abort.abort()
	process.once("SIGINT", onSignal)
	process.once("SIGTERM", onSignal)
	try {
		return await operation(abort.signal)
	} finally {
		process.removeListener("SIGINT", onSignal)
		process.removeListener("SIGTERM", onSignal)
	}
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const values = new Map<string, string>()
	const flags = new Set<string>()
	for (let index = 0; index < argv.length; index++) {
		const option = argv[index]
		if (option === undefined) throw new Error("Missing campaign option")
		if (["--init-root", "--enable-reviewed-patches", "--dry-run", "--gate"].includes(option)) {
			if (flags.has(option)) throw new Error("Duplicate campaign flag")
			flags.add(option)
		} else if (
			[
				"--config",
				"--suite",
				"--provider",
				"--model-id",
				"--effort",
				"--id",
				"--root",
				"--profile-dir",
				"--storage-recovery-root",
				"--shared-storage-root",
				"--vscode-version",
				"--vscode-executable",
			].includes(option)
		) {
			const value = argv[++index]
			if (!value || value.startsWith("--") || values.has(option)) throw new Error("Invalid campaign option")
			values.set(option, value)
		} else throw new Error("Unknown campaign option")
	}
	const recoveryRoot = values.get("--storage-recovery-root")
	const sharedRoot = values.get("--shared-storage-root")
	const suite = values.get("--suite")
	const gate = flags.has("--gate")
	if (gate && (!["development", "reliability"].includes(suite ?? "") || values.get("--provider") !== "live-copilot"))
		throw new Error("Gate requires --suite development or reliability --provider live-copilot")
	const suiteOptions = ["--provider", "--model-id", "--effort", "--id"]
	if (
		(recoveryRoot || sharedRoot || values.has("--config")) &&
		(suite || suiteOptions.some((key) => values.has(key)))
	)
		throw new Error("Conflicting campaign modes")
	if (!suite && suiteOptions.some((key) => values.has(key))) throw new Error("Suite options require --suite")
	if (!suite && flags.has("--dry-run")) throw new Error("Dry run requires --suite")
	if (suite && flags.has("--enable-reviewed-patches")) throw new Error("Suites are report-only")
	if (sharedRoot) {
		if (recoveryRoot || flags.size || values.has("--config") || values.has("--root") || values.has("--profile-dir"))
			throw new Error("Conflicting campaign modes")
		const version = values.get("--vscode-version") ?? "1.122.1"
		if (!HOST_VERSIONS.includes(version as CampaignHost["version"]))
			throw new Error("Unsupported shared-storage host")
		const report = await withProcessSignals((signal) =>
			runSharedStorageCampaign({
				fixtureRoot: sharedRoot,
				host: { version: version as CampaignHost["version"], executable: values.get("--vscode-executable") },
				signal,
			}),
		)
		process.stdout.write(JSON.stringify(report) + "\n")
		return report.status === "passed" ? 0 : 2
	}
	if (recoveryRoot) {
		if (flags.size || values.has("--config") || values.has("--root") || values.has("--profile-dir"))
			throw new Error("Conflicting campaign modes")
		const version = values.get("--vscode-version") ?? "1.122.1"
		if (!HOST_VERSIONS.includes(version as CampaignHost["version"])) throw new Error("Unsupported recovery host")
		const report = await withProcessSignals((signal) =>
			runStorageRecoveryCampaign({
				fixtureRoot: recoveryRoot,
				host: { version: version as CampaignHost["version"], executable: values.get("--vscode-executable") },
				signal,
			}),
		)
		process.stdout.write(
			JSON.stringify({
				schemaVersion: 1,
				status: report.status,
				stopReason: report.stopReason,
				hostVersion: report.hostVersion,
				phases: report.phases.length,
			}) + "\n",
		)
		return report.status === "passed" ? 0 : 2
	}
	if (!suite && (values.has("--vscode-version") || values.has("--vscode-executable")))
		throw new Error("Host options require a specialized storage campaign mode")
	const configPath = values.get("--config")
	const rootPath = values.get("--root")
	if ((!configPath && !suite) || !rootPath) throw new Error("Campaign requires --config or --suite, and --root")
	assertSafeRoot(rootPath)
	// Validate explicit profile spelling before initializing any campaign directories.
	const profileRoot = resolveCampaignProfileRoot(rootPath, values.get("--profile-dir"))
	let config: CampaignConfig
	if (suite) {
		const provider = values.get("--provider")
		if (provider !== "scripted" && provider !== "live-copilot")
			throw new Error("Suite requires an explicit provider")
		const version = values.get("--vscode-version")
		if (values.has("--vscode-executable") && !version) throw new Error("Suite executable requires an exact version")
		if (version && !HOST_VERSIONS.includes(version as CampaignHost["version"]))
			throw new Error("Unsupported suite host")
		config = createDevelopmentSuite({
			suite,
			id:
				values.get("--id") ??
				`development-${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID().slice(0, 8)}`,
			provider,
			modelId: values.get("--model-id"),
			effort: values.get("--effort"),
			host: version
				? { version: version as CampaignHost["version"], executable: values.get("--vscode-executable") }
				: undefined,
		})
	} else {
		config = parseCampaignConfig(
			JSON.parse((await readBounded(path.resolve(configPath!), 1_048_576)).toString("utf8")),
			flags.has("--enable-reviewed-patches"),
		)
	}
	if (gate) assertLiveGateConfig(config)
	if (flags.has("--dry-run")) {
		process.stdout.write(
			JSON.stringify({
				schemaVersion: 1,
				status: "planned",
				...(gate ? { gate: true, preparation: ["test:unit", "test:smoke:1221"] } : {}),
				evidenceMode: config.provider.mode === "live-copilot" ? "live-model" : "harness-only",
				config,
			}) + "\n",
		)
		return 0
	}
	const root = await openCampaignRoot(rootPath, flags.has("--init-root"))
	const store = await createReportStore(root, config.id)
	const repositoryRoot = path.resolve(__dirname, "../../..")
	let reportedAttempts = 0
	const operations = createExtensionCampaignOperations({
		config,
		campaignRoot: root,
		runDirectory: store.directory,
		profileRoot: values.has("--profile-dir") ? profileRoot : path.join(root, "profiles"),
		repositoryRoot,
		persistReport: async (report) => {
			await store.persistReport(report)
			if (gate && report.attempts.length > reportedAttempts) {
				for (const attempt of report.attempts.slice(reportedAttempts))
					process.stdout.write(
						JSON.stringify({
							event: "live-gate-attempt",
							host: attempt.request.host.version,
							scenario: attempt.request.scenarioId,
							status: attempt.result.status,
							requests: attempt.result.usage.requests,
						}) + "\n",
					)
				reportedAttempts = report.attempts.length
			}
		},
		pnpmCliPath: process.env.npm_execpath,
	})
	return withProcessSignals(async (signal) => {
		let artifactDigest: string | undefined
		if (gate) {
			process.stdout.write("Preparing live gate: unit tests, fresh build, and exact VS Code 1.122.1 contracts.\n")
			if (!(await prepareLiveGate(repositoryRoot, process.env.npm_execpath, store.directory, signal))) {
				const resultPath = path.join(store.directory, "gate-result.json")
				await fs.writeFile(
					resultPath,
					JSON.stringify({
						schemaVersion: 1,
						status: "blocked",
						reason: "preparation_failed",
						campaignId: config.id,
					}) + "\n",
					{ flag: "wx", mode: 0o600 },
				)
				process.stdout.write(
					JSON.stringify({ status: "blocked", reason: "preparation_failed", resultPath }) + "\n",
				)
				return 2
			}
			await prepareLiveSidecar()
			artifactDigest = await fingerprintGateArtifacts(
				repositoryRoot,
				config.scenarioIds.includes("completion-idle"),
			)
			await fs.writeFile(
				path.join(store.directory, "gate-plan.json"),
				JSON.stringify({ config, artifactDigest }) + "\n",
				{
					flag: "wx",
					mode: 0o600,
				},
			)
		}
		const report = await runCampaign(config, operations, signal, { reproduceFailures: !gate })
		if (gate) {
			const verdict = evaluateLiveGate(config, report)
			const artifactsUnchanged = await fingerprintGateArtifacts(
				repositoryRoot,
				config.scenarioIds.includes("completion-idle"),
			).then(
				(digest) => digest === artifactDigest,
				() => false,
			)
			const result = {
				...verdict,
				artifactDigest,
				artifactsUnchanged,
				status: artifactsUnchanged ? verdict.status : "failed",
			}
			const resultPath = path.join(store.directory, "gate-result.json")
			await fs.writeFile(resultPath, JSON.stringify(result, null, 2) + "\n", { flag: "wx", mode: 0o600 })
			process.stdout.write(JSON.stringify({ ...result, resultPath }) + "\n")
			return result.status === "passed" ? 0 : campaignExitCode(report) || 1
		}
		process.stdout.write(
			JSON.stringify({
				schemaVersion: 1,
				campaignId: report.id,
				stopReason: report.stopReason,
				counts: report.counts,
				usage: report.usage,
				retention: report.retention?.status ?? null,
				verifiedRepairs: report.repairs.filter((entry) => entry.verified).length,
			}) + "\n",
		)
		return campaignExitCode(report)
	})
}

if (require.main === module) {
	main()
		.then((code) => {
			process.exitCode = code
		})
		.catch(() => {
			// Configuration paths, provider payloads and raw child diagnostics are intentionally not echoed.
			process.stderr.write('{"schemaVersion":1,"status":"blocked","failure":"campaign_setup_or_report_failed"}\n')
			process.exitCode = 2
		})
}
