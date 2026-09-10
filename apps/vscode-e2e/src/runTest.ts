import * as path from "path"
import * as fs from "fs/promises"
import { randomUUID } from "crypto"

import { prepareTestProfile, cleanupTestProfile } from "./testProfile"
import { acquireProfileLease } from "./hostOwnership"
import { TestRunError, testRunFailureCode, describeTestRunFailure, type TestRunFailureCode } from "./runFailure"
import { launchExtensionHost, HostLaunchCancelledError, type HostLaunchOptions } from "./hostLaunch"
import {
	prepareLiveSidecar,
	readLiveHostReceipt,
	LIVE_HOST_STARTED,
	LIVE_HOST_COMPLETION,
	type HostLaunchKind,
} from "./liveHostProtocol"
import { readBounded } from "./evidence/paths"
import {
	prepareEvidenceRun,
	captureRepositoryEvidence,
	type RepositoryEvidence,
	type EvidenceRetentionOptions,
} from "./evidence"
import { finalizeRunEvidence, finalizeRunRetention, type RunRetentionReport } from "./runEvidence"
import { validateLiveSetupTimeout } from "./suite/liveCopilot"

export type ProviderMode = "live" | "scripted" | "vscode-lm-fixture" | "live-copilot"

export interface ExtensionTestRunOptions {
	/** Programmatic cancellation of the owned host. It does not authorize terminating unrelated descendants. */
	signal?: AbortSignal
	providerMode: ProviderMode
	vscodeVersion: string
	vscodeExecutablePath?: string
	/** Test an artifact installed in the owned profile, without overriding Alpha from the source checkout. */
	installedExtensionPath?: string
	workspace?: string
	profileDir?: string
	artifactsDir?: string
	initializeProfile?: boolean
	modelId?: string
	modelFamily?: string
	reasoningEffort?: string
	setup?: boolean
	/** No default deadline. Explicitly bounded interactive setup only. */
	setupTimeoutMs?: number
	testFile?: string
	testGrep?: string
	runId?: string
	scenarioId?: string
	scenarioPhase?: "run" | "prepare" | "continue"
	scenarioResultPath?: string
	requestLimit?: number
	/** Campaign phases remain protected until their controller has written its terminal report. */
	retainEvidenceForCampaign?: boolean
	evidenceRetention?: Pick<EvidenceRetentionOptions, "maxRuns" | "maxBytes" | "maxAgeMs">
	/** Scenario-specific environment. Runner identity and safety fields cannot be overridden. */
	extensionTestsEnv?: Record<string, string>
}

export interface ExtensionTestRunResult {
	launchKind?: HostLaunchKind
	sharedDataDir?: string
	completionReceiptPath?: string
	completionStatus?: "passed" | "failed"
	runId: string
	exitCode: number
	providerMode: ProviderMode
	vscodeVersion: string
	workspace: string
	userDataDir: string
	extensionsDir: string
	artifactsDir: string
	profileDir?: string
	temporaryRoot?: string
	retained: boolean
	actualVSCodeVersion?: string
	actualModelId?: string
	actualReasoningEffort?: string
	evidenceManifestPath?: string
	captureComplete?: boolean
	evidenceFailure?: "evidence-failed"
	retentionResultPath?: string
	retention?: RunRetentionReport
	status: "passed" | "failed" | "blocked"
	execution: "test-seam" | "extension-host"
	hostExitObserved: boolean
	launchedHostPid?: number
	extensionHostPid?: number
	extensionHostParentPid?: number
	ownershipGate?: "verified"
	/** Host exit only; host-side artifacts carry the more specific cause. */
	failure?: TestRunFailureCode
	guidance?: string
}

export interface ExtensionTestRunDependencies {
	/** Explicit diagnostic override; deterministic gates retain their default extension-test host. */
	launchKind?: HostLaunchKind
	launch?: (options: HostLaunchOptions) => Promise<number>
	afterRun?: (result: ExtensionTestRunResult) => Promise<void>
	extensionDevelopmentPath?: string
	extensionTestsPath?: string
	vscodeLmFixturePath?: string
}

const providerModes: readonly ProviderMode[] = ["live", "scripted", "vscode-lm-fixture", "live-copilot"]
const flags = new Set(["--init-profile", "--setup", "--retain-evidence-for-campaign"])
const valueOptions = new Set([
	"--provider",
	"--vscode-version",
	"--vscode-executable",
	"--installed-extension",
	"--workspace",
	"--profile-dir",
	"--artifacts-dir",
	"--model-id",
	"--model-family",
	"--reasoning-effort",
	"--setup-timeout-ms",
	"--file",
	"--grep",
	"--run-id",
	"--scenario-id",
	"--scenario-phase",
	"--scenario-result-path",
	"--request-limit",
])

export function readRunOptions(
	argv: string[] = process.argv.slice(2),
	env: NodeJS.ProcessEnv = process.env,
): ExtensionTestRunOptions {
	const parsed = new Map<string, string>()
	for (let index = 0; index < argv.length; index++) {
		const key = argv[index]
		if (key === undefined) throw new Error("Missing test runner option")
		if (!flags.has(key) && !valueOptions.has(key)) throw new Error(`Unknown test runner option: ${key}`)
		if (parsed.has(key)) throw new Error(`Duplicate test runner option: ${key}`)
		if (flags.has(key)) {
			parsed.set(key, "true")
			continue
		}
		const value = argv[++index]
		if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`)
		parsed.set(key, value)
	}
	const providerMode = parsed.get("--provider") ?? env.ALPHA_E2E_PROVIDER_MODE ?? "live"
	if (!providerModes.includes(providerMode as ProviderMode)) throw new Error("Unsupported E2E provider mode")
	const phase = parsed.get("--scenario-phase")
	if (phase !== undefined && phase !== "run" && phase !== "prepare" && phase !== "continue")
		throw new Error("Invalid scenario phase")
	const limit = parsed.get("--request-limit")
	if (limit && (!/^\d+$/.test(limit) || !Number.isSafeInteger(Number(limit)) || Number(limit) < 1)) {
		throw new Error("Request limit must be a positive safe integer")
	}
	const timeout = parsed.get("--setup-timeout-ms")
	if (timeout !== undefined && !/^\d+$/.test(timeout))
		throw new TestRunError("invalid-options", "Setup timeout must be an integer")
	const setupTimeoutMs = timeout === undefined ? undefined : Number(timeout)
	validateLiveSetupTimeout(setupTimeoutMs, parsed.has("--setup"))
	return {
		providerMode: providerMode as ProviderMode,
		vscodeVersion: parsed.get("--vscode-version") ?? env.VSCODE_VERSION ?? "1.122.1",
		vscodeExecutablePath: parsed.get("--vscode-executable") ?? env.VSCODE_EXECUTABLE_PATH,
		workspace: parsed.get("--workspace"),
		profileDir: parsed.get("--profile-dir"),
		artifactsDir: parsed.get("--artifacts-dir"),
		initializeProfile: parsed.has("--init-profile"),
		modelId: parsed.get("--model-id"),
		modelFamily: parsed.get("--model-family"),
		reasoningEffort: parsed.get("--reasoning-effort"),
		setup: parsed.has("--setup"),
		setupTimeoutMs,
		testFile: parsed.get("--file") ?? env.TEST_FILE,
		testGrep: parsed.get("--grep") ?? env.TEST_GREP,
		runId: parsed.get("--run-id"),
		scenarioId: parsed.get("--scenario-id"),
		scenarioPhase: phase,
		scenarioResultPath: parsed.get("--scenario-result-path"),
		installedExtensionPath: parsed.get("--installed-extension"),
		requestLimit: limit ? Number(limit) : undefined,
		retainEvidenceForCampaign: parsed.has("--retain-evidence-for-campaign"),
	}
}

async function readExtensionId(extensionPath: string): Promise<string> {
	const manifest = JSON.parse(await fs.readFile(path.join(extensionPath, "package.json"), "utf8")) as {
		name?: unknown
		publisher?: unknown
	}
	if (typeof manifest.name !== "string" || typeof manifest.publisher !== "string") {
		throw new Error("The extension manifest must define string name and publisher fields")
	}
	return `${manifest.publisher}.${manifest.name}`
}

type HostPreflight = {
	runId: string
	actualVSCodeVersion: string
	status: "passed" | "failed" | "blocked"
	ownershipGate?: "verified"
	code?: string
	actualModelId?: string
	actualReasoningEffort?: string
}

async function readHostPreflight(artifactsDir: string, runId: string): Promise<HostPreflight> {
	try {
		const hostPath = path.join(artifactsDir, "host-preflight.json")
		const stat = await fs.lstat(hostPath)
		if (!stat.isFile() || stat.size > 64 * 1024) throw new Error("Invalid host evidence")
		const host: unknown = JSON.parse(await fs.readFile(hostPath, "utf8"))
		if (
			!host ||
			typeof host !== "object" ||
			!("runId" in host) ||
			host.runId !== runId ||
			!("actualVSCodeVersion" in host) ||
			typeof host.actualVSCodeVersion !== "string" ||
			!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(host.actualVSCodeVersion) ||
			!("status" in host) ||
			!["passed", "failed", "blocked"].includes(String(host.status))
		) {
			throw new Error("Invalid host evidence")
		}
		return host as HostPreflight
	} catch {
		throw new TestRunError("host-preflight-missing", "Missing or invalid host preflight evidence")
	}
}

async function readVerifiedHostIdentity(result: ExtensionTestRunResult): Promise<{
	extensionHostPid?: number
	extensionHostParentPid?: number
}> {
	if (result.execution !== "extension-host" || result.ownershipGate !== "verified") return {}
	try {
		const identityPath = path.join(result.artifactsDir, "host-identity.json")
		const stat = await fs.lstat(identityPath)
		if (!stat.isFile() || stat.size > 4096) return {}
		const host: Record<string, unknown> = JSON.parse(await fs.readFile(identityPath, "utf8"))
		if (
			host.runId !== result.runId ||
			host.ownershipGate !== "verified" ||
			host.actualVSCodeVersion !== result.actualVSCodeVersion ||
			!Number.isSafeInteger(host.pid) ||
			Number(host.pid) < 1 ||
			!Number.isSafeInteger(host.ppid) ||
			Number(host.ppid) < 1
		)
			return {}
		return { extensionHostPid: Number(host.pid), extensionHostParentPid: Number(host.ppid) }
	} catch {
		// Missing identity cannot authorize offline repair, even when the direct host process closed.
		return {}
	}
}

/** The same launch boundary serves the CLI, unit tests, and the external campaign controller. */
export async function runExtensionTests(
	options: ExtensionTestRunOptions,
	dependencies: ExtensionTestRunDependencies = {},
): Promise<ExtensionTestRunResult> {
	if (!providerModes.includes(options.providerMode)) throw new Error("Unsupported E2E provider mode")
	if (options.installedExtensionPath && (!options.profileDir || !path.isAbsolute(options.installedExtensionPath))) {
		throw new TestRunError(
			"invalid-options",
			"Installed extension tests require an absolute artifact path and an owned profile",
		)
	}
	const launchKind =
		dependencies.launchKind ??
		(options.providerMode === "live-copilot" || options.installedExtensionPath
			? "development-sidecar"
			: "extension-test")
	if (
		!["extension-test", "development-sidecar"].includes(launchKind) ||
		((options.providerMode === "live-copilot" || options.installedExtensionPath) &&
			launchKind !== "development-sidecar") ||
		(launchKind === "development-sidecar" &&
			(!options.profileDir || !["live-copilot", "scripted"].includes(options.providerMode)))
	)
		throw new TestRunError("invalid-options", "Invalid persistent host launch mode")
	validateLiveSetupTimeout(options.setupTimeoutMs, options.setup === true)
	if (options.retainEvidenceForCampaign !== undefined && typeof options.retainEvidenceForCampaign !== "boolean") {
		throw new TestRunError("invalid-options", "Campaign retention hold must be a boolean")
	}
	for (const [key, value] of Object.entries(options.evidenceRetention ?? {})) {
		if (!["maxRuns", "maxBytes", "maxAgeMs"].includes(key) || !Number.isSafeInteger(value) || value < 1) {
			throw new TestRunError("invalid-options", "Evidence retention limits must be positive safe integers")
		}
	}
	if (!/^(?:\d+\.\d+\.\d+|stable|insiders)$/.test(options.vscodeVersion)) throw new Error("Invalid VS Code version")
	if (
		options.providerMode === "live-copilot" &&
		(!options.profileDir || (!options.setup && !options.modelId?.trim()))
	) {
		throw new Error("Live Copilot tests require a dedicated --profile-dir and an exact --model-id")
	}
	if (options.setup && options.providerMode !== "live-copilot") throw new Error("--setup requires live-copilot")
	if (
		options.requestLimit !== undefined &&
		(!Number.isSafeInteger(options.requestLimit) || options.requestLimit < 1)
	) {
		throw new Error("Request limit must be a positive safe integer")
	}
	const runId = options.runId ?? randomUUID()
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error("Invalid test run ID")
	const extensionDevelopmentPath =
		options.installedExtensionPath ??
		dependencies.extensionDevelopmentPath ??
		path.resolve(__dirname, "../../../src")
	const extensionTestsPath = dependencies.extensionTestsPath ?? path.resolve(__dirname, "./suite/index")
	const extensionId = await readExtensionId(extensionDevelopmentPath)
	const fixturePath = dependencies.vscodeLmFixturePath ?? path.resolve(__dirname, "../fixtures/vscode-lm-provider")
	const fixtureId = options.providerMode === "vscode-lm-fixture" ? await readExtensionId(fixturePath) : undefined
	const profile = await prepareTestProfile({ ...options, sharedData: launchKind === "development-sidecar" })
	if (options.installedExtensionPath) {
		const relative = path.relative(
			await fs.realpath(profile.extensionsDir),
			await fs.realpath(options.installedExtensionPath),
		)
		if (!relative || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
			throw new TestRunError(
				"invalid-options",
				"Installed artifact must be inside the owned profile's extensions directory",
			)
		}
	}
	const sidecarPath = launchKind === "development-sidecar" ? await prepareLiveSidecar() : undefined
	const developmentPaths = [
		...(options.installedExtensionPath ? [] : [extensionDevelopmentPath]),
		...(sidecarPath ? [sidecarPath] : options.providerMode === "vscode-lm-fixture" ? [fixturePath] : []),
	]
	const { artifactDirectory: artifactsDir } = await prepareEvidenceRun({ artifactsRoot: profile.artifactsDir, runId })
	const scenarioResultPath = options.scenarioResultPath ?? path.join(artifactsDir, "workflow-result.json")
	if (!path.isAbsolute(scenarioResultPath) || path.dirname(path.resolve(scenarioResultPath)) !== artifactsDir) {
		throw new TestRunError(
			"invalid-options",
			"Scenario results must be directly inside this run's artifact directory",
		)
	}
	const startedAt = new Date().toISOString()
	const liveExpected = { runId, nonce: randomUUID(), actualVSCodeVersion: options.vscodeVersion }
	let repositoryBefore: RepositoryEvidence | undefined
	const identity = {
		runId,
		providerMode: options.providerMode,
		vscodeVersion: options.vscodeVersion,
		launchKind,
		...(sidecarPath ? { completionReceiptPath: path.join(artifactsDir, LIVE_HOST_COMPLETION) } : {}),
		...profile,
		artifactsDir,
		execution: dependencies.launch ? ("test-seam" as const) : ("extension-host" as const),
	}
	let result: ExtensionTestRunResult | undefined
	let release: (() => Promise<void>) | undefined
	let hostExitObserved = false
	let launchedHostPid: number | undefined
	try {
		if (options.signal?.aborted) throw new HostLaunchCancelledError()
		release = profile.profileDir ? await acquireProfileLease(profile.userDataDir) : undefined
		repositoryBefore = await captureRepositoryEvidence(profile.workspace)
		await fs.writeFile(
			path.join(artifactsDir, "launch.json"),
			JSON.stringify(
				{
					schemaVersion: 1,
					runId,
					requestedHostVersion: options.vscodeVersion,
					providerMode: options.providerMode,
					launchKind,
					...(sidecarPath ? { nonce: liveExpected.nonce, sharedDataDir: profile.sharedDataDir } : {}),
					modelId: options.modelId,
					modelFamily: options.modelFamily,
					reasoningEffort: options.reasoningEffort,
					testFile: options.testFile,
					setup: options.setup === true,
				},
				null,
				2,
			),
			{ flag: "wx" },
		)
		const exitCode = await (
			dependencies.launch ??
			((launchOptions: HostLaunchOptions) =>
				launchExtensionHost(
					launchOptions,
					(pid) => {
						launchedHostPid = pid
					},
					options.signal,
				))
		)({
			extensionDevelopmentPath: developmentPaths.length === 1 ? developmentPaths[0]! : developmentPaths,
			...(sidecarPath
				? { launchKind: "development-sidecar" as const, liveHost: { artifactsDir, expected: liveExpected } }
				: { launchKind: "extension-test" as const, extensionTestsPath }),
			reuseMachineInstall: false,
			launchArgs: [
				profile.workspace,
				`--user-data-dir=${profile.userDataDir}`,
				`--extensions-dir=${profile.extensionsDir}`,
				...(profile.sharedDataDir ? [`--shared-data-dir=${profile.sharedDataDir}`] : []),
				"--new-window",
				// Live workflow tests need real Git integration; preserve the old fixture isolation.
				...(options.providerMode === "live-copilot" ? [] : ["--disable-extension=vscode.git"]),
			],
			extensionTestsEnv: {
				...process.env,
				...options.extensionTestsEnv,
				ALPHA_E2E_EXTENSION_ID: extensionId,
				ALPHA_E2E_INSTALLED_EXTENSION_DIR: options.installedExtensionPath,
				ALPHA_E2E_LAUNCH_KIND: launchKind,
				ALPHA_E2E_LAUNCH_NONCE: sidecarPath ? liveExpected.nonce : undefined,
				ALPHA_E2E_SHARED_DATA_DIR: profile.sharedDataDir,
				ALPHA_E2E_PROVIDER_MODE: options.providerMode,
				ALPHA_E2E_VSCODE_LM_FIXTURE_ID: fixtureId,
				ALPHA_E2E_WORKSPACE: profile.workspace,
				ALPHA_E2E_RUN_ID: runId,
				ALPHA_E2E_PROFILE_DIR: profile.profileDir,
				ALPHA_E2E_ARTIFACTS_DIR: artifactsDir,
				ALPHA_E2E_RUNNER_PID: process.pid.toString(),
				ALPHA_E2E_EXPECTED_VSCODE_VERSION: /^\d+\.\d+\.\d+$/.test(options.vscodeVersion)
					? options.vscodeVersion
					: undefined,
				ALPHA_E2E_MODEL_ID: options.modelId,
				ALPHA_E2E_MODEL_FAMILY: options.modelFamily,
				ALPHA_E2E_REASONING_EFFORT: options.reasoningEffort,
				ALPHA_E2E_SETUP: options.setup ? "1" : undefined,
				ALPHA_E2E_SETUP_TIMEOUT_MS: options.setupTimeoutMs?.toString(),
				ALPHA_E2E_SCENARIO_ID: options.scenarioId,
				ALPHA_E2E_SCENARIO_PHASE: options.scenarioPhase,
				ALPHA_E2E_SCENARIO_RESULT_PATH: scenarioResultPath,
				ALPHA_E2E_REQUEST_LIMIT: options.requestLimit?.toString(),
				TEST_FILE: options.testFile ?? (options.scenarioId ? "workflow.test" : undefined),
				TEST_GREP: options.testGrep,
			},
			...(options.vscodeExecutablePath
				? { vscodeExecutablePath: path.resolve(options.vscodeExecutablePath) }
				: { version: options.vscodeVersion }),
		})
		hostExitObserved = !dependencies.launch
		const host = await readHostPreflight(artifactsDir, runId)
		let completionStatus: "passed" | "failed" | undefined
		if (sidecarPath) {
			const started = await readLiveHostReceipt(artifactsDir, LIVE_HOST_STARTED, liveExpected)
			const completed = await readLiveHostReceipt(artifactsDir, LIVE_HOST_COMPLETION, liveExpected, started)
			const hostIdentity = JSON.parse(
				(await readBounded(path.join(artifactsDir, "host-identity.json"), 4096)).toString("utf8"),
			)
			if (
				hostIdentity.runId !== runId ||
				hostIdentity.actualVSCodeVersion !== options.vscodeVersion ||
				hostIdentity.ownershipGate !== "verified" ||
				hostIdentity.pid !== completed.pid ||
				hostIdentity.ppid !== completed.ppid
			)
				throw new TestRunError("host-completion-invalid", "Host identity does not match completion")
			completionStatus = completed.status === "passed" ? "passed" : "failed"
			if (completionStatus === "failed" && host.status === "passed")
				throw new TestRunError(completed.failure ?? "host-failed", "Live sidecar reported failure")
		}
		if (/^\d+\.\d+\.\d+$/.test(options.vscodeVersion) && host.actualVSCodeVersion !== options.vscodeVersion) {
			throw new TestRunError("host-version-mismatch", "Host version mismatch")
		}
		const ownershipGate =
			"ownershipGate" in host && host.ownershipGate === "verified" ? ("verified" as const) : undefined
		if (profile.profileDir && !ownershipGate)
			throw new TestRunError("host-not-owned", "Host ownership was not verified")
		const failure = exitCode !== 0 || host.status !== "passed" ? testRunFailureCode(host, "host-failed") : undefined
		result = {
			...identity,
			...(completionStatus ? { completionStatus } : {}),
			status: failure ? (host.status === "blocked" ? "blocked" : "failed") : "passed",
			hostExitObserved,
			ownershipGate,
			actualVSCodeVersion: host.actualVSCodeVersion,
			actualModelId: host.actualModelId,
			actualReasoningEffort: host.actualReasoningEffort,
			exitCode: failure ? exitCode || 1 : 0,
			retained: Boolean(profile.profileDir) || Boolean(failure),
			failure,
		}
	} catch (error) {
		if (!dependencies.launch && error instanceof HostLaunchCancelledError) {
			hostExitObserved = error.hostExitCode !== undefined
		}
		// A thrown host error may include auth/provider payloads. Retain its host-side evidence without echoing it.
		let failure = testRunFailureCode(error, "host-failed")
		if (sidecarPath && failure === "host-preflight-missing") {
			try {
				const started = await readLiveHostReceipt(artifactsDir, LIVE_HOST_STARTED, liveExpected)
				const completed = await readLiveHostReceipt(artifactsDir, LIVE_HOST_COMPLETION, liveExpected, started)
				// A module-load failure can precede suite preflight; its exact failed receipt may explain it,
				// but a passed receipt can never substitute for missing preflight/host identity.
				if (completed.status === "failed") failure = completed.failure ?? failure
			} catch {
				/* Incomplete correlation cannot improve or replace the known failure. */
			}
		}
		let actualVSCodeVersion: string | undefined
		let ownershipGate: "verified" | undefined
		try {
			const host = await readHostPreflight(artifactsDir, runId)
			failure = testRunFailureCode(host, failure)
			actualVSCodeVersion = host.actualVSCodeVersion
			ownershipGate = host.ownershipGate === "verified" ? "verified" : undefined
		} catch {
			/* Missing or invalid evidence cannot improve the known failure classification. */
		}
		result = {
			...identity,
			status: failure === "host-failed" ? "failed" : "blocked",
			hostExitObserved,
			actualVSCodeVersion,
			ownershipGate,
			exitCode: 1,
			retained: true,
			failure,
		}
	} finally {
		try {
			if (result) {
				result.retentionResultPath = path.join(artifactsDir, "retention-result.json")
				result.launchedHostPid = launchedHostPid
				Object.assign(result, await readVerifiedHostIdentity(result))
				try {
					await finalizeRunEvidence({
						options,
						profile,
						result,
						extensionId,
						extensionDevelopmentPath,
						startedAt,
						repositoryBefore,
						scenarioResultPath,
					})
					await dependencies.afterRun?.(result)
				} catch {
					result = {
						...result,
						status: result.status === "passed" ? "failed" : result.status,
						exitCode: result.exitCode || 1,
						retained: true,
						captureComplete: false,
						failure: result.failure ?? "evidence-failed",
						evidenceFailure: "evidence-failed",
					}
				}
				if (result.failure) result.guidance = describeTestRunFailure({ code: result.failure }).guidance
				await fs.writeFile(path.join(artifactsDir, "run-result.json"), JSON.stringify(result, null, 2), {
					flag: "wx",
				})
			}
		} finally {
			// A launcher that died without a numeric close leaves an uncertain host; keep its lease for offline inspection.
			if (!launchedHostPid || hostExitObserved) await release?.()
		}
	}
	try {
		result.retention = await finalizeRunRetention(options, profile, result)
	} catch {
		// A missing retention sidecar is a closed failure too; no raw filesystem text escapes to callers.
		result.retention = {
			schemaVersion: 1,
			runId,
			status: "failed",
			eligibility: options.retainEvidenceForCampaign ? "held" : "not-eligible",
			failure: "evidence-retention-failed",
		}
	}
	if (result.retention.status !== "complete") {
		result = {
			...result,
			exitCode: result.exitCode || 1,
			status: result.status === "passed" ? "blocked" : result.status,
			retained: true,
			failure: result.failure ?? "evidence-retention-failed",
		}
		result.guidance = describeTestRunFailure({ code: result.failure }).guidance
	}
	await cleanupTestProfile(profile, result.exitCode === 0)
	return result
}

if (require.main === module) {
	Promise.resolve()
		.then(() => runExtensionTests(readRunOptions()))
		.then((result) => {
			console.log(JSON.stringify(result))
			process.exitCode = result.exitCode
		})
		.catch((error: unknown) => {
			console.error(
				JSON.stringify({
					schemaVersion: 1,
					status: "blocked",
					...describeTestRunFailure(error),
				}),
			)
			process.exitCode = 1
		})
}
