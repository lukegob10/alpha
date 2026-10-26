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
import { runNestedRestartCampaign } from "./campaign/nestedRestartCampaign"
import { assertLiveGateConfig, evaluateLiveGate, fingerprintGateArtifacts, prepareLiveGate } from "./campaign/liveGate"
import {
	HOST_VERSIONS,
	type CampaignConfig,
	type CampaignEvaluationIdentity,
	type CampaignHost,
	type CampaignReport,
} from "./campaign/types"
import { assertSafeRoot, readBounded } from "./evidence/paths"
import { prepareLiveSidecar } from "./liveHostProtocol"
import { captureCampaignEvaluationIdentity, finishCampaignEvaluationIdentity } from "./campaign/evaluationIdentity"
import { campaignAccountingMatches } from "./campaign/reportAccounting"
import {
	createLiveModelMatrix,
	runLiveModelMatrix,
	type CampaignExecutionResult,
	type LiveModelMatrixPlan,
	type LiveModelMatrixReport,
} from "./campaign/liveModelMatrix"

export function campaignExitCode(report: CampaignReport): number {
	if (report.stopReason !== "completed") return 2
	if (report.retention && report.retention.status !== "complete") return 2
	if ((report.evaluationPlan || report.sampling) && !campaignAccountingMatches(report)) return 2
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

interface PreparedMatrixGate {
	artifactDigest: string
	identity: CampaignEvaluationIdentity
}

interface CampaignExecutionOptions {
	config: CampaignConfig
	root: string
	profileRoot: string
	repositoryRoot: string
	pnpmCliPath?: string
	gate: boolean
	suite?: string
	preparedGate?: PreparedMatrixGate
}

/** Single-model campaigns and matrix members use the same execution and evidence boundaries. */
async function executeConfiguredCampaign(
	options: CampaignExecutionOptions,
	signal: AbortSignal,
): Promise<CampaignExecutionResult> {
	const { config, root, profileRoot, repositoryRoot, pnpmCliPath, gate, suite, preparedGate } = options
	const store = await createReportStore(root, config.id)
	let reportedAttempts = 0
	const operations = createExtensionCampaignOperations({
		config,
		campaignRoot: root,
		runDirectory: store.directory,
		profileRoot,
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
		pnpmCliPath,
	})
	let artifactDigest: string | undefined
	if (gate) {
		if (!preparedGate)
			process.stdout.write("Preparing live gate: unit tests, fresh build, and exact VS Code 1.138.0 contracts.\n")
		if (
			!preparedGate &&
			!(await prepareLiveGate(
				repositoryRoot,
				pnpmCliPath,
				store.directory,
				signal,
				undefined,
				suite === "core" ? "full" : "none",
			))
		) {
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
			process.stdout.write(JSON.stringify({ status: "blocked", reason: "preparation_failed", resultPath }) + "\n")
			return { exitCode: 2, resultPath }
		}
		await prepareLiveSidecar()
		artifactDigest =
			preparedGate?.artifactDigest ??
			(await fingerprintGateArtifacts(repositoryRoot, config.scenarioIds.includes("completion-idle")))
		await fs.writeFile(
			path.join(store.directory, "gate-plan.json"),
			JSON.stringify({ config, artifactDigest }) + "\n",
			{
				flag: "wx",
				mode: 0o600,
			},
		)
	}
	// The first live launch materializes its fixed manifest inside the fingerprinted harness.
	// Prepare it before the baseline even outside gate mode, so preparation is not reported as source drift.
	if (!gate && config.provider.mode === "live-copilot") await prepareLiveSidecar()
	const identityBefore = await captureCampaignEvaluationIdentity(repositoryRoot, config)
	if (
		preparedGate &&
		(!finishCampaignEvaluationIdentity(preparedGate.identity, identityBefore).unchanged ||
			(await fingerprintGateArtifacts(repositoryRoot, config.scenarioIds.includes("completion-idle"))) !==
				preparedGate.artifactDigest)
	) {
		const resultPath = path.join(store.directory, "gate-result.json")
		await fs.writeFile(
			resultPath,
			JSON.stringify({
				schemaVersion: 1,
				status: "blocked",
				reason: "matrix_conditions_changed",
				campaignId: config.id,
			}) + "\n",
			{ flag: "wx", mode: 0o600 },
		)
		return { exitCode: 2, resultPath, artifactsUnchanged: false }
	}
	await fs.writeFile(
		path.join(store.directory, "evaluation-identity-before.json"),
		JSON.stringify(identityBefore) + "\n",
		{ flag: "wx", mode: 0o600 },
	)
	const report = await runCampaign(config, operations, signal)
	report.evaluationIdentity = finishCampaignEvaluationIdentity(
		identityBefore,
		await captureCampaignEvaluationIdentity(repositoryRoot, config),
	)
	report.evaluationPlan = {
		scenarioIds: config.scenarioIds,
		hostVersions: config.hosts.map((host) => host.version),
		samples: config.samples,
	}
	await store.persistReport(report)
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
		return {
			exitCode: result.status === "passed" ? 0 : campaignExitCode(report) || 1,
			report,
			resultPath,
			artifactsUnchanged,
		}
	}
	process.stdout.write(
		JSON.stringify({
			schemaVersion: 1,
			campaignId: report.id,
			stopReason: report.stopReason,
			counts: report.counts,
			countScope: "all-attempts",
			sampling: report.sampling,
			usage: report.usage,
			retention: report.retention?.status ?? null,
			verifiedRepairs: report.repairs.filter((entry) => entry.verified).length,
		}) + "\n",
	)
	return { exitCode: campaignExitCode(report), report }
}

async function executeModelMatrix(
	plan: LiveModelMatrixPlan,
	options: Omit<CampaignExecutionOptions, "config" | "gate" | "preparedGate">,
	signal: AbortSignal,
): Promise<number> {
	const store = await createReportStore<LiveModelMatrixReport>(options.root, plan.id)
	await fs.writeFile(path.join(store.directory, "matrix-plan.json"), JSON.stringify(plan, null, 2) + "\n", {
		flag: "wx",
		mode: 0o600,
	})
	// Prepare once: rebuilding between models would change the conditions being compared.
	let prepared = false
	try {
		prepared = await prepareLiveGate(
			options.repositoryRoot,
			options.pnpmCliPath,
			store.directory,
			signal,
			undefined,
			options.suite === "core" ? "full" : "none",
		)
	} catch (error) {
		if (!signal.aborted) throw error
		// Owned prerequisite cleanup has settled; publish cancellation without launching a model.
	}
	let preparedGate: PreparedMatrixGate | undefined
	if (prepared && !signal.aborted) {
		await prepareLiveSidecar()
		preparedGate = {
			artifactDigest: await fingerprintGateArtifacts(
				options.repositoryRoot,
				plan.campaigns[0]!.scenarioIds.includes("completion-idle"),
			),
			identity: await captureCampaignEvaluationIdentity(options.repositoryRoot, plan.campaigns[0]!),
		}
	}
	const report = await runLiveModelMatrix(
		plan,
		{
			run: (config) =>
				preparedGate
					? executeConfiguredCampaign({ ...options, config, gate: true, preparedGate }, signal)
					: Promise.resolve({ exitCode: 2 }),
			persist: store.persistReport,
		},
		signal,
	)
	const resultPath = path.join(store.directory, "matrix-result.json")
	await fs.writeFile(
		resultPath,
		JSON.stringify(
			{
				...report,
				preparationSucceeded: prepared,
				artifactDigest: preparedGate?.artifactDigest,
			},
			null,
			2,
		) + "\n",
		{ flag: "wx", mode: 0o600 },
	)
	process.stdout.write(JSON.stringify({ ...report, resultPath }) + "\n")
	return report.status === "passed" ? 0 : report.status === "failed" ? 1 : 2
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
	const values = new Map<string, string>()
	const flags = new Set<string>()
	for (let index = 0; index < argv.length; index++) {
		const option = argv[index]
		if (option === undefined) throw new Error("Missing campaign option")
		if (
			[
				"--init-root",
				"--enable-reviewed-patches",
				"--dry-run",
				"--gate",
				"--diagnose-failures",
				"--model-matrix",
			].includes(option)
		) {
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
				"--nested-restart-root",
				"--vscode-version",
				"--vscode-executable",
				"--max-requests",
				"--samples",
				"--decision-plan-digest",
				"--decision-time-window",
			].includes(option)
		) {
			const value = argv[++index]
			if (!value || value.startsWith("--") || values.has(option)) throw new Error("Invalid campaign option")
			values.set(option, value)
		} else throw new Error("Unknown campaign option")
	}
	const recoveryRoot = values.get("--storage-recovery-root")
	const sharedRoot = values.get("--shared-storage-root")
	const nestedRoot = values.get("--nested-restart-root")
	const suite = values.get("--suite")
	const matrix = flags.has("--model-matrix")
	const gate = flags.has("--gate") || matrix
	if (matrix && (!suite || values.has("--model-id") || values.has("--effort")))
		throw new Error("Model matrix requires a suite and fixes its model IDs and reasoning efforts")
	if (
		gate &&
		(!["development", "reliability", "core"].includes(suite ?? "") || values.get("--provider") !== "live-copilot")
	)
		throw new Error("Gate requires --suite development, reliability or core --provider live-copilot")
	const suiteOptions = [
		"--provider",
		"--model-id",
		"--effort",
		"--id",
		"--max-requests",
		"--samples",
		"--decision-plan-digest",
		"--decision-time-window",
	]
	const integerOption = (name: string) => {
		const value = values.get(name)
		if (value === undefined) return undefined
		if (!/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(Number(value)))
			throw new Error("Invalid campaign integer option")
		return Number(value)
	}
	if (
		(recoveryRoot || sharedRoot || nestedRoot || values.has("--config")) &&
		(suite || suiteOptions.some((key) => values.has(key)))
	)
		throw new Error("Conflicting campaign modes")
	if (!suite && suiteOptions.some((key) => values.has(key))) throw new Error("Suite options require --suite")
	if (!suite && flags.has("--dry-run")) throw new Error("Dry run requires --suite")
	if (!suite && flags.has("--diagnose-failures")) throw new Error("Diagnostic collection requires --suite")
	if (gate && flags.has("--diagnose-failures")) throw new Error("Live gates collect original samples only")
	if (suite && flags.has("--enable-reviewed-patches")) throw new Error("Suites are report-only")
	if (nestedRoot) {
		if (
			recoveryRoot ||
			sharedRoot ||
			flags.size ||
			values.has("--config") ||
			values.has("--root") ||
			values.has("--profile-dir")
		)
			throw new Error("Conflicting campaign modes")
		const version = values.get("--vscode-version") ?? "1.138.0"
		if (version !== "1.138.0") throw new Error("Nested restart requires the exact reference host")
		const report = await withProcessSignals((signal) =>
			runNestedRestartCampaign({
				fixtureRoot: nestedRoot,
				host: { version, executable: values.get("--vscode-executable") },
				signal,
			}),
		)
		process.stdout.write(JSON.stringify(report) + "\n")
		return report.status === "passed" ? 0 : 2
	}
	if (sharedRoot) {
		if (recoveryRoot || flags.size || values.has("--config") || values.has("--root") || values.has("--profile-dir"))
			throw new Error("Conflicting campaign modes")
		const version = values.get("--vscode-version") ?? "1.138.0"
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
		const version = values.get("--vscode-version") ?? "1.138.0"
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
	let matrixPlan: LiveModelMatrixPlan | undefined
	if (suite) {
		const provider = values.get("--provider")
		if (provider !== "scripted" && provider !== "live-copilot")
			throw new Error("Suite requires an explicit provider")
		const version = values.get("--vscode-version")
		if (values.has("--vscode-executable") && !version) throw new Error("Suite executable requires an exact version")
		if (version && !HOST_VERSIONS.includes(version as CampaignHost["version"]))
			throw new Error("Unsupported suite host")
		const suiteSettings = {
			suite,
			id:
				values.get("--id") ??
				`development-${new Date().toISOString().replace(/[^0-9]/g, "")}-${randomUUID().slice(0, 8)}`,
			maxRequests: integerOption("--max-requests"),
			samples: integerOption("--samples"),
			decisionPlanDigest: values.get("--decision-plan-digest"),
			decisionTimeWindow: values.get("--decision-time-window"),
			host: version
				? { version: version as CampaignHost["version"], executable: values.get("--vscode-executable") }
				: undefined,
		}
		if (matrix) {
			matrixPlan = createLiveModelMatrix(suiteSettings)
			config = matrixPlan.campaigns[0]!
		} else {
			config = createDevelopmentSuite({
				...suiteSettings,
				provider,
				modelId: values.get("--model-id"),
				effort: values.get("--effort"),
				collectionMode: flags.has("--diagnose-failures") ? "sample-then-diagnose" : "sample-only",
			})
		}
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
				...(gate
					? {
							gate: true,
							preparation: [
								"test:unit",
								"test:smoke:1380",
								...(suite === "core" ? ["test:core:regressions", "test:core:1380:run"] : []),
							],
						}
					: {}),
				evidenceMode: config.provider.mode === "live-copilot" ? "live-model" : "harness-only",
				...(matrixPlan
					? {
							kind: "alpha-live-model-matrix",
							plan: matrixPlan,
							maxRequests: matrixPlan.campaigns.reduce(
								(sum, campaign) => sum + campaign.budgets.maxRequests,
								0,
							),
						}
					: { config }),
			}) + "\n",
		)
		return 0
	}
	const root = await openCampaignRoot(rootPath, flags.has("--init-root"))
	const execution = {
		root,
		profileRoot: values.has("--profile-dir") ? profileRoot : path.join(root, "profiles"),
		repositoryRoot: path.resolve(__dirname, "../../.."),
		pnpmCliPath: process.env.npm_execpath,
		suite,
	}
	return withProcessSignals(async (signal) =>
		matrixPlan
			? executeModelMatrix(matrixPlan, execution, signal)
			: (await executeConfiguredCampaign({ ...execution, config, gate }, signal)).exitCode,
	)
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
