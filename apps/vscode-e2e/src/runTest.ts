import * as path from "path"
import * as fs from "fs/promises"
import * as os from "os"
import { randomUUID } from "crypto"

import { prepareTestProfile, cleanupTestProfile } from "./testProfile"
import { acquireProfileLease } from "./hostOwnership"
import {
	TestRunError,
	testRunFailureCode,
	describeTestRunFailure,
	isTestExecutionCounts,
	isTestSuiteSelection,
	testSuiteMochaOptions,
	testSuiteOutcome,
	type TestExecutionCounts,
	type TestSuiteSelection,
	type TestRunFailureCode,
} from "./runFailure"
import {
	launchExtensionHost,
	HostLaunchCancelledError,
	HostLaunchFailureError,
	type HostLaunchOptions,
} from "./hostLaunch"
import {
	prepareLiveSidecar,
	readLiveHostReceipt,
	LIVE_HOST_STARTED,
	LIVE_HOST_COMPLETION,
	validateLiveExecutionTimeout,
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
import { writeHarnessReceipt } from "./harnessReceipt"
import {
	isLiveProviderIdentityReceipt,
	LIVE_PROVIDER_EXTENSION_ID,
	type LiveProviderIdentityReceipt,
} from "./liveProviderIdentity"
import {
	prepareImprovementCapture,
	validateImprovementCaptureOptions,
	ImprovementCaptureHelperError,
	type ImprovementCaptureResult,
	type ImprovementCaptureState,
	type ImprovementCaptureInvoker,
} from "./evidence/improvementCapture"
import { observeHostCaptureClosure, type HostCaptureClosure } from "./evidence/hostCaptureClosure"

export type ProviderMode = "live" | "scripted" | "vscode-lm-fixture" | "live-copilot"

export interface ExtensionTestRunOptions {
	/** Programmatic rendered-UI tests only. Chromium selects an ephemeral loopback debugging port. */
	rendererDebuggingPort?: 0
	/** Programmatic cancellation of the owned host. It does not authorize terminating unrelated descendants. */
	signal?: AbortSignal
	providerMode: ProviderMode
	vscodeVersion: string
	vscodeExecutablePath?: string
	/** Test an artifact installed in the owned profile, without overriding Alpha from the source checkout. */
	installedExtensionPath?: string
	/** Override the development extension root when a campaign runs from a frozen build snapshot. */
	extensionDevelopmentPath?: string
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
	/** Overall automatic live execution deadline; interactive setup has its own explicit deadline. */
	executionTimeoutMs?: number
	testFile?: string
	testGrep?: string
	/** Hard gates require the entire selected file, with grep and exclusive tests forbidden. */
	requireAllTests?: boolean
	runId?: string
	scenarioId?: string
	scenarioPhase?: "run" | "prepare" | "continue"
	scenarioResultPath?: string
	requestLimit?: number
	/** Explicit private rich capture of one public problem-solving attempt; never inherited from the environment. */
	improvementEvidence?: boolean
	improvementTaskId?: string
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
	alphaHome?: string
	retained: boolean
	actualVSCodeVersion?: string
	actualModelId?: string
	actualReasoningEffort?: string
	providerIdentity?: LiveProviderIdentityReceipt
	requireAllTests?: boolean
	testCounts?: TestExecutionCounts
	testSelection?: TestSuiteSelection
	evidenceManifestPath?: string
	captureComplete?: boolean
	improvementEvidence?: ImprovementCaptureResult
	evidenceFailure?: "evidence-failed"
	retentionResultPath?: string
	retention?: RunRetentionReport
	status: "passed" | "failed" | "blocked"
	execution: "test-seam" | "extension-host"
	hostExitObserved: boolean
	hostCleanupVerified?: boolean
	hostCaptureClosure?: HostCaptureClosure
	/** A helper's uncertain cleanup is independent from the VS Code host's own closure proof. */
	captureHelperCleanupVerified?: boolean
	launchedHostPid?: number
	extensionHostPid?: number
	extensionHostParentPid?: number
	ownershipGate?: "verified"
	/** Host exit only; host-side artifacts carry the more specific cause. */
	failure?: TestRunFailureCode
	guidance?: string
}

export interface ExtensionTestRunDependencies {
	/** Private collector seam for deterministic lease/cancellation tests; never establishes a real host execution. */
	improvementCaptureInvoker?: ImprovementCaptureInvoker
	/** Owned launch/lease seams exercise failure cleanup without starting VS Code. */
	launchHost?: typeof launchExtensionHost
	acquireLease?: typeof acquireProfileLease
	/** Explicit diagnostic override; deterministic gates retain their default extension-test host. */
	launchKind?: HostLaunchKind
	launch?: (options: HostLaunchOptions) => Promise<number>
	afterRun?: (result: ExtensionTestRunResult) => Promise<void>
	extensionDevelopmentPath?: string
	extensionTestsPath?: string
	vscodeLmFixturePath?: string
}

const providerModes: readonly ProviderMode[] = ["live", "scripted", "vscode-lm-fixture", "live-copilot"]
const flags = new Set([
	"--init-profile",
	"--setup",
	"--retain-evidence-for-campaign",
	"--require-all-tests",
	"--improvement-evidence",
])
const valueOptions = new Set([
	"--provider",
	"--vscode-version",
	"--vscode-executable",
	"--installed-extension",
	"--extension-development-path",
	"--workspace",
	"--profile-dir",
	"--artifacts-dir",
	"--model-id",
	"--model-family",
	"--reasoning-effort",
	"--setup-timeout-ms",
	"--execution-timeout-ms",
	"--file",
	"--grep",
	"--run-id",
	"--scenario-id",
	"--scenario-phase",
	"--scenario-result-path",
	"--request-limit",
	"--improvement-task-id",
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
	const executionTimeout = parsed.get("--execution-timeout-ms")
	if (executionTimeout !== undefined && !/^\d+$/.test(executionTimeout))
		throw new TestRunError("invalid-options", "Execution timeout must be an integer")
	const executionTimeoutMs = executionTimeout === undefined ? undefined : Number(executionTimeout)
	validateLiveExecutionTimeout(executionTimeoutMs, parsed.has("--setup"))
	const testGrep = parsed.get("--grep") ?? env.TEST_GREP
	testSuiteMochaOptions({ testGrep, requireAllTests: parsed.has("--require-all-tests") })
	return {
		providerMode: providerMode as ProviderMode,
		vscodeVersion: parsed.get("--vscode-version") ?? env.VSCODE_VERSION ?? "1.138.0",
		vscodeExecutablePath: parsed.get("--vscode-executable") ?? env.VSCODE_EXECUTABLE_PATH,
		workspace: parsed.get("--workspace") ?? env.ALPHA_E2E_WORKSPACE_ROOT,
		profileDir: parsed.get("--profile-dir") ?? env.ALPHA_E2E_PROFILE_ROOT,
		artifactsDir: parsed.get("--artifacts-dir") ?? env.ALPHA_E2E_ARTIFACTS_ROOT,
		initializeProfile: parsed.has("--init-profile"),
		modelId: parsed.get("--model-id"),
		modelFamily: parsed.get("--model-family"),
		reasoningEffort: parsed.get("--reasoning-effort"),
		setup: parsed.has("--setup"),
		setupTimeoutMs,
		executionTimeoutMs,
		testFile: parsed.get("--file") ?? env.TEST_FILE,
		testGrep,
		requireAllTests: parsed.has("--require-all-tests"),
		runId: parsed.get("--run-id"),
		scenarioId: parsed.get("--scenario-id"),
		scenarioPhase: phase,
		scenarioResultPath: parsed.get("--scenario-result-path"),
		installedExtensionPath: parsed.get("--installed-extension"),
		extensionDevelopmentPath: parsed.get("--extension-development-path"),
		requestLimit: limit ? Number(limit) : undefined,
		improvementEvidence: parsed.has("--improvement-evidence"),
		improvementTaskId: parsed.get("--improvement-task-id"),
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
	providerIdentity?: LiveProviderIdentityReceipt
	stage?: string
	requireAllTests?: boolean
	testCounts?: TestExecutionCounts
	testSelection?: TestSuiteSelection
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
		if (
			("requireAllTests" in host && typeof host.requireAllTests !== "boolean") ||
			("testSelection" in host && !isTestSuiteSelection(host.testSelection)) ||
			("testCounts" in host && !isTestExecutionCounts(host.testCounts))
		)
			throw new Error("Invalid host test counts")
		if ("providerIdentity" in host && !isLiveProviderIdentityReceipt(host.providerIdentity))
			throw new Error("Invalid live provider identity")
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

function requireCaptureHelperCleanup(uncertain: boolean, cancelled?: boolean): void {
	if (uncertain) throw new ImprovementCaptureHelperError(false, cancelled)
}

/** The same launch boundary serves the CLI, unit tests, and the external campaign controller. */
export async function runExtensionTests(
	options: ExtensionTestRunOptions,
	dependencies: ExtensionTestRunDependencies = {},
): Promise<ExtensionTestRunResult> {
	if (!providerModes.includes(options.providerMode)) throw new Error("Unsupported E2E provider mode")
	if (
		options.rendererDebuggingPort !== undefined &&
		(options.rendererDebuggingPort !== 0 ||
			options.providerMode !== "scripted" ||
			!options.profileDir ||
			![
				"rendered-ui-probe.test",
				"composer-ui.test",
				"request-user-input-ui.test",
				"transcript-lifecycle-ui.test",
				"file-review-ui.test",
				"managed-agents.acceptance.test",
				"reasoning-ui.test",
				"history-ui.test",
				"task-navigation-ui.test",
				"editor-chat-reload.test",
				"tickets-ui.test",
			].includes(options.testFile ?? ""))
	) {
		throw new TestRunError(
			"invalid-options",
			"Renderer debugging requires the scripted rendered-UI fixture and an owned profile",
		)
	}
	if (options.installedExtensionPath && (!options.profileDir || !path.isAbsolute(options.installedExtensionPath))) {
		throw new TestRunError(
			"invalid-options",
			"Installed extension tests require an absolute artifact path and an owned profile",
		)
	}
	if (
		options.extensionDevelopmentPath !== undefined &&
		(!path.isAbsolute(options.extensionDevelopmentPath) || options.extensionDevelopmentPath.includes("\0"))
	) {
		throw new TestRunError("invalid-options", "Development extension path must be an absolute path")
	}
	if (options.extensionDevelopmentPath && options.installedExtensionPath) {
		throw new TestRunError("invalid-options", "Choose one extension source path")
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
	validateLiveExecutionTimeout(options.executionTimeoutMs, options.setup === true)
	validateImprovementCaptureOptions(options)
	if (options.executionTimeoutMs !== undefined && launchKind !== "development-sidecar")
		throw new TestRunError("invalid-options", "Execution timeout requires an automatic development sidecar")
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
	if (options.requireAllTests !== undefined && typeof options.requireAllTests !== "boolean")
		throw new TestRunError("invalid-options", "Required test policy must be a boolean")
	testSuiteMochaOptions(options)
	if (options.setup && options.requireAllTests)
		throw new TestRunError("invalid-options", "Interactive setup does not execute a required test suite")
	if (
		options.requestLimit !== undefined &&
		(!Number.isSafeInteger(options.requestLimit) || options.requestLimit < 1)
	) {
		throw new Error("Request limit must be a positive safe integer")
	}
	const runId = options.runId ?? randomUUID()
	if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(runId)) throw new Error("Invalid test run ID")
	const extensionDevelopmentPath =
		options.extensionDevelopmentPath ??
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
	// Fixtures use the real Git executable. Keep optional SCM observers isolated in live hosts too:
	// bundled Copilot 0.53 crashes when a fixture repository opens.
	// VS Code 1.138.0 languageModels.ts rejects duplicate vendor registrations (retrieved 2026-10-25).
	// The deterministic Claude fixture owns the copilot vendor only in the vscode-lm-fixture lane.
	const disabledExtensions = [
		"vscode.git",
		...(options.providerMode === "vscode-lm-fixture" ? [LIVE_PROVIDER_EXTENSION_ID] : []),
	]
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
		execution:
			dependencies.launch ||
			dependencies.launchHost ||
			dependencies.acquireLease ||
			dependencies.improvementCaptureInvoker
				? ("test-seam" as const)
				: ("extension-host" as const),
	}
	let result: ExtensionTestRunResult | undefined
	let improvementCapture: ImprovementCaptureState | undefined
	let release: (() => Promise<void>) | undefined
	let hostExitObserved = false
	let hostCleanupVerified: boolean | undefined
	let captureHelperCleanupVerified: boolean | undefined
	let captureHelperCleanupUncertain = false
	let launchedHostPid: number | undefined
	let alphaHome: string | undefined
	try {
		if (options.signal?.aborted) throw new HostLaunchCancelledError()
		release = profile.profileDir
			? await (dependencies.acquireLease ?? acquireProfileLease)(profile.userDataDir)
			: undefined
		// Extension activation may capture its host-local store before a test module loads.
		// Every launch gets its own home, including launches using persistent editor profiles.
		alphaHome = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "alpha-vscode-e2e-home-")))
		improvementCapture = await prepareImprovementCapture(
			{
				options,
				profile,
				hostRunId: runId,
				runDirectory: artifactsDir,
				extensionId,
				extensionRoot: extensionDevelopmentPath,
				startedAt,
			},
			dependencies.improvementCaptureInvoker,
		)
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
					alphaHome,
					fixtureIsolation: { disabledExtensions, gitExecution: "native-cli" },
					...(sidecarPath ? { nonce: liveExpected.nonce, sharedDataDir: profile.sharedDataDir } : {}),
					modelId: options.modelId,
					modelFamily: options.modelFamily,
					reasoningEffort: options.reasoningEffort,
					testFile: options.testFile,
					testGrep: options.testGrep,
					requireAllTests: options.requireAllTests === true,
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
				(dependencies.launchHost ?? launchExtensionHost)(
					launchOptions,
					(pid) => {
						launchedHostPid = pid
					},
					options.signal,
				))
		)({
			extensionDevelopmentPath: developmentPaths.length === 1 ? developmentPaths[0]! : developmentPaths,
			...(sidecarPath
				? {
						launchKind: "development-sidecar" as const,
						liveHost: {
							artifactsDir,
							expected: liveExpected,
							interactiveSetup: options.setup === true,
							executionTimeoutMs: options.executionTimeoutMs,
						},
					}
				: { launchKind: "extension-test" as const, extensionTestsPath }),
			reuseMachineInstall: false,
			launchArgs: [
				...(options.rendererDebuggingPort === 0 ? ["--remote-debugging-port=0"] : []),
				profile.workspace,
				`--user-data-dir=${profile.userDataDir}`,
				`--extensions-dir=${profile.extensionsDir}`,
				...(profile.sharedDataDir ? [`--shared-data-dir=${profile.sharedDataDir}`] : []),
				"--new-window",
				...disabledExtensions.map((id) => `--disable-extension=${id}`),
			],
			extensionTestsEnv: {
				...process.env,
				...options.extensionTestsEnv,
				ALPHA_HOME: alphaHome,
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
				ALPHA_E2E_IMPROVEMENT_EVIDENCE: options.improvementEvidence ? "1" : undefined,
				ALPHA_E2E_IMPROVEMENT_TASK_ID: options.improvementTaskId,
				ALPHA_E2E_REQUIRE_ALL_TESTS: options.requireAllTests ? "1" : "0",
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
		if ((profile.profileDir || !dependencies.launch) && !ownershipGate)
			throw new TestRunError("host-not-owned", "Host ownership was not verified")
		if (
			host.testSelection &&
			(host.testSelection.testFile !== (options.testFile || (options.scenarioId ? "workflow.test" : null)) ||
				host.testSelection.grep !== (options.testGrep || null) ||
				host.testSelection.forbidOnly !== (options.requireAllTests === true))
		)
			throw new TestRunError("host-preflight-missing", "Observed suite selection does not match this launch")
		if (exitCode === 0 && host.status === "passed" && options.requireAllTests) {
			if (
				host.stage !== "suite-complete" ||
				host.requireAllTests !== true ||
				!host.testCounts ||
				!host.testSelection ||
				host.testSelection.grep !== null ||
				host.testSelection.forbidOnly !== true
			)
				throw new TestRunError("host-preflight-missing", "Required suite completion evidence is missing")
			const { failure } = testSuiteOutcome(
				host.testCounts.failed,
				{ tests: host.testCounts.total, passes: host.testCounts.passed, pending: host.testCounts.pending },
				{ requireAllTests: true },
			)
			if (failure) throw new TestRunError(failure, "Required suite did not execute every selected test")
		}
		const failure = exitCode !== 0 || host.status !== "passed" ? testRunFailureCode(host, "host-failed") : undefined
		if (
			options.providerMode === "live-copilot" &&
			!options.setup &&
			!failure &&
			host.providerIdentity?.status !== "unchanged"
		)
			throw new TestRunError("provider-unavailable", "Live provider identity is missing or changed")
		result = {
			...identity,
			alphaHome,
			...(completionStatus ? { completionStatus } : {}),
			status: failure ? (host.status === "blocked" ? "blocked" : "failed") : "passed",
			hostExitObserved,
			ownershipGate,
			actualVSCodeVersion: host.actualVSCodeVersion,
			actualModelId: host.actualModelId,
			actualReasoningEffort: host.actualReasoningEffort,
			providerIdentity: host.providerIdentity,
			requireAllTests: host.requireAllTests,
			testCounts: host.testCounts,
			testSelection: host.testSelection,
			exitCode: failure ? exitCode || 1 : 0,
			retained: Boolean(profile.profileDir) || Boolean(failure),
			failure,
		}
	} catch (error) {
		if (error instanceof ImprovementCaptureHelperError) {
			captureHelperCleanupVerified = error.cleanupVerified
			captureHelperCleanupUncertain ||= !error.cleanupVerified
		}
		if (
			!dependencies.launch &&
			(error instanceof HostLaunchCancelledError || error instanceof HostLaunchFailureError)
		) {
			hostExitObserved = error.hostExitObserved
			hostCleanupVerified = error.cleanupVerified
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
		let requireAllTests: boolean | undefined
		let testCounts: TestExecutionCounts | undefined
		let testSelection: TestSuiteSelection | undefined
		let providerIdentity: LiveProviderIdentityReceipt | undefined
		let actualModelId: string | undefined
		let actualReasoningEffort: string | undefined
		try {
			const host = await readHostPreflight(artifactsDir, runId)
			if (!(error instanceof HostLaunchCancelledError || error instanceof HostLaunchFailureError))
				failure = testRunFailureCode(host, failure)
			actualVSCodeVersion = host.actualVSCodeVersion
			ownershipGate = host.ownershipGate === "verified" ? "verified" : undefined
			requireAllTests = host.requireAllTests
			testCounts = host.testCounts
			testSelection = host.testSelection
			providerIdentity = host.providerIdentity
			actualModelId = host.actualModelId
			actualReasoningEffort = host.actualReasoningEffort
		} catch {
			/* Missing or invalid evidence cannot improve the known failure classification. */
		}
		result = {
			...identity,
			alphaHome,
			status: failure === "host-failed" ? "failed" : "blocked",
			hostExitObserved,
			hostCleanupVerified,
			captureHelperCleanupVerified,
			actualVSCodeVersion,
			ownershipGate,
			requireAllTests,
			testCounts,
			testSelection,
			providerIdentity,
			actualModelId,
			actualReasoningEffort,
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
					requireCaptureHelperCleanup(captureHelperCleanupUncertain, options.signal?.aborted)
					if (improvementCapture) {
						const closure = await observeHostCaptureClosure({
							hostExitObserved: result.execution === "extension-host" && result.hostExitObserved,
							previousCleanupVerified: result.hostCleanupVerified,
							launchedHostPid,
							extensionHostPid: result.extensionHostPid,
							extensionHostParentPid: result.extensionHostParentPid,
							userDataDir: result.userDataDir,
						})
						result.hostCaptureClosure = closure
						result.hostCleanupVerified = hostCleanupVerified = closure.cleanupVerified
						await fs.writeFile(
							path.join(artifactsDir, "improvement", "host-closure.json"),
							JSON.stringify(closure, null, 2) + "\n",
							{ flag: "wx", mode: 0o600 },
						)
					}
					await finalizeRunEvidence({
						options,
						profile,
						result,
						extensionId,
						extensionDevelopmentPath,
						startedAt,
						repositoryBefore,
						scenarioResultPath,
						improvementCapture,
						improvementCaptureInvoker: dependencies.improvementCaptureInvoker,
					})
					await dependencies.afterRun?.(result)
				} catch (error) {
					if (error instanceof ImprovementCaptureHelperError) {
						captureHelperCleanupVerified = error.cleanupVerified
						captureHelperCleanupUncertain ||= !error.cleanupVerified
					}
					const failure = testRunFailureCode(error, "evidence-failed")
					result = {
						...result,
						status:
							result.status === "passed"
								? failure === "host-cancelled"
									? "blocked"
									: "failed"
								: result.status,
						exitCode: result.exitCode || 1,
						retained: true,
						captureComplete: false,
						failure: result.failure ?? failure,
						evidenceFailure: "evidence-failed",
						captureHelperCleanupVerified,
					}
				}
				if (result.failure) result.guidance = describeTestRunFailure({ code: result.failure }).guidance
				await fs.writeFile(path.join(artifactsDir, "run-result.json"), JSON.stringify(result, null, 2), {
					flag: "wx",
				})
			}
		} finally {
			// A launcher that died without a numeric close leaves an uncertain host; keep its lease for offline inspection.
			if (
				!captureHelperCleanupUncertain &&
				(!launchedHostPid || (hostExitObserved && hostCleanupVerified !== false))
			)
				await release?.()
		}
	}
	try {
		requireCaptureHelperCleanup(captureHelperCleanupUncertain, options.signal?.aborted)
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
	if (alphaHome && result.exitCode === 0)
		await fs.rm(alphaHome, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
	if (process.env.ALPHA_HARNESS_EVIDENCE_DIR && result.execution === "extension-host") {
		try {
			await writeHarnessReceipt(process.env.ALPHA_HARNESS_EVIDENCE_DIR, options, result, startedAt)
		} catch {
			result = {
				...result,
				status: result.status === "passed" ? "blocked" : result.status,
				exitCode: result.exitCode || 1,
				failure: result.failure ?? "evidence-failed",
			}
		}
	}
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
