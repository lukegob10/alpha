import { mkdir, rename, unlink, writeFile } from "node:fs/promises"
import { join, resolve } from "node:path"

import { getVscodeLlmModelInfo, type ModelInfo, type RooCodeAPI, type RooCodeSettings } from "@alpha-code/types"

import type { LanguageModelChat, LanguageModelChatResponse } from "vscode"

export const LIVE_COPILOT_VENDOR = "copilot" as const
export const LIVE_COPILOT_ARTIFACT_FILENAME = "live-copilot-preflight.json" as const
export const LIVE_COPILOT_DISCOVERY_TIMEOUT_MS = 15_000
export const LIVE_COPILOT_SETUP_REQUEST_TIMEOUT_MS = 15_000
export const LIVE_COPILOT_STREAM_CLOSE_TIMEOUT_MS = 500

export const alphaReasoningEfforts = ["disable", "none", "minimal", "low", "medium", "high", "xhigh", "max"] as const

export type AlphaReasoningEffort = (typeof alphaReasoningEfforts)[number]

export type CopilotModelMetadata = {
	readonly vendor?: string
	readonly family?: string
	readonly version?: string
	readonly id?: string
	readonly name?: string
	readonly maxInputTokens?: number
}

export type LiveCopilotModelSelector = {
	readonly vendor: typeof LIVE_COPILOT_VENDOR
	readonly id: string
	readonly family?: string
}

export type LiveCopilotModelSelectionRequest = {
	readonly modelId: string
	readonly modelFamily?: string
}

export type ExactCopilotModelSelectionFailureCode =
	| "invalid-model-id"
	| "invalid-model-family"
	| "model-not-found"
	| "model-family-mismatch"
	| "model-selection-ambiguous"

export type ExactCopilotModelSelection<T extends CopilotModelMetadata> =
	| {
			readonly ok: true
			readonly status: "selected"
			readonly model: T
			readonly selector: LiveCopilotModelSelector
	  }
	| {
			readonly ok: false
			readonly status: "invalid" | "not-found" | "ambiguous"
			readonly code: ExactCopilotModelSelectionFailureCode
	  }

function asSelectionRequest(
	requestOrModelId: LiveCopilotModelSelectionRequest | string,
	modelFamily?: string,
): LiveCopilotModelSelectionRequest {
	return typeof requestOrModelId === "string"
		? { modelId: requestOrModelId, ...(modelFamily !== undefined ? { modelFamily } : {}) }
		: requestOrModelId
}

/**
 * Validate a model against the provider-owned identity returned by VS Code.
 *
 * Model ids are opaque. This function deliberately does not inspect names,
 * versions, aliases, prefixes, case, or catalog entries. An id without a
 * matching Copilot model is unavailable, and duplicate matches are ambiguous.
 */
export function validateExactCopilotModelSelection<T extends CopilotModelMetadata>(
	discoveredModels: readonly T[],
	request: LiveCopilotModelSelectionRequest,
): ExactCopilotModelSelection<T>
export function validateExactCopilotModelSelection<T extends CopilotModelMetadata>(
	discoveredModels: readonly T[],
	modelId: string,
	modelFamily?: string,
): ExactCopilotModelSelection<T>
export function validateExactCopilotModelSelection<T extends CopilotModelMetadata>(
	discoveredModels: readonly T[],
	requestOrModelId: LiveCopilotModelSelectionRequest | string,
	modelFamily?: string,
): ExactCopilotModelSelection<T> {
	const request = asSelectionRequest(requestOrModelId, modelFamily)

	if (typeof request.modelId !== "string" || request.modelId.length === 0) {
		return { ok: false, status: "invalid", code: "invalid-model-id" }
	}

	if (
		request.modelFamily !== undefined &&
		(typeof request.modelFamily !== "string" || request.modelFamily.length === 0)
	) {
		return { ok: false, status: "invalid", code: "invalid-model-family" }
	}

	const idMatches = discoveredModels.filter(
		(model) => model.vendor === LIVE_COPILOT_VENDOR && model.id === request.modelId,
	)
	const exactMatches =
		request.modelFamily === undefined
			? idMatches
			: idMatches.filter((model) => model.family === request.modelFamily)

	if (exactMatches.length === 0) {
		return {
			ok: false,
			status: "not-found",
			code:
				request.modelFamily !== undefined && idMatches.length > 0 ? "model-family-mismatch" : "model-not-found",
		}
	}

	if (exactMatches.length !== 1) {
		return { ok: false, status: "ambiguous", code: "model-selection-ambiguous" }
	}
	const selectedModel = exactMatches[0]
	if (selectedModel === undefined) {
		return { ok: false, status: "not-found", code: "model-not-found" }
	}

	return {
		ok: true,
		status: "selected",
		model: selectedModel,
		selector: {
			vendor: LIVE_COPILOT_VENDOR,
			id: request.modelId,
			...(request.modelFamily !== undefined ? { family: request.modelFamily } : {}),
		},
	}
}

/** Select the one exact Copilot model, or undefined when the request is not safe to use. */
export function selectExactCopilotModel<T extends CopilotModelMetadata>(
	discoveredModels: readonly T[],
	request: LiveCopilotModelSelectionRequest,
): T | undefined
export function selectExactCopilotModel<T extends CopilotModelMetadata>(
	discoveredModels: readonly T[],
	modelId: string,
	modelFamily?: string,
): T | undefined
export function selectExactCopilotModel<T extends CopilotModelMetadata>(
	discoveredModels: readonly T[],
	requestOrModelId: LiveCopilotModelSelectionRequest | string,
	modelFamily?: string,
): T | undefined {
	const selection = validateExactCopilotModelSelection(
		discoveredModels,
		asSelectionRequest(requestOrModelId, modelFamily),
	)
	return selection.ok ? selection.model : undefined
}

export type AlphaVscodeLmModelInfo = Pick<ModelInfo, "supportsReasoningEffort">

export type LiveCopilotReasoningStatus = "not-requested" | "disabled" | "supported" | "unsupported" | "unknown"

export type LiveCopilotReasoningValidation = {
	readonly status: LiveCopilotReasoningStatus
	readonly requested?: string
	readonly appliedEffort?: AlphaReasoningEffort
	readonly supportedEfforts?: readonly string[]
}

/**
 * Resolve the same static model information consumed by Alpha's vscode-lm
 * request adapter. Only the provider-owned family is consulted here. Opaque
 * ids, display names, and versions cannot make an unknown model look supported.
 */
export function getAlphaVscodeLmModelInfo(model: CopilotModelMetadata): AlphaVscodeLmModelInfo | undefined {
	if (model.vendor !== LIVE_COPILOT_VENDOR || typeof model.family !== "string" || model.family.length === 0) {
		return undefined
	}

	return getVscodeLlmModelInfo({ vendor: LIVE_COPILOT_VENDOR, family: model.family })
}

function isAlphaReasoningEffort(value: string): value is AlphaReasoningEffort {
	return alphaReasoningEfforts.includes(value as AlphaReasoningEffort)
}

/**
 * Mirror the adapter's reasoning-effort gate without affirming support for
 * models whose Alpha capability metadata is unknown.
 */
export function validateRequestedReasoningEffort(
	model: CopilotModelMetadata,
	effort?: string,
	alphaModelInfo: AlphaVscodeLmModelInfo | undefined = getAlphaVscodeLmModelInfo(model),
): LiveCopilotReasoningValidation {
	if (effort === undefined) {
		return { status: "not-requested" }
	}

	if (effort === "disable") {
		return { status: "disabled", requested: effort, appliedEffort: effort }
	}

	if (!isAlphaReasoningEffort(effort)) {
		return { status: "unsupported", requested: effort }
	}

	const support = alphaModelInfo?.supportsReasoningEffort
	if (Array.isArray(support)) {
		const supportedEfforts = [...support]
		return support.includes(effort)
			? { status: "supported", requested: effort, appliedEffort: effort, supportedEfforts }
			: { status: "unsupported", requested: effort, supportedEfforts }
	}

	if (support === true) {
		return { status: "supported", requested: effort, appliedEffort: effort }
	}

	if (support === false) {
		return { status: "unsupported", requested: effort }
	}

	return { status: "unknown", requested: effort }
}

/** Build the exact Alpha settings patch only when the requested effort is safe to apply. */
export function buildLiveCopilotConfiguration(
	current: RooCodeSettings,
	selector: LiveCopilotModelSelector,
	reasoning: LiveCopilotReasoningValidation,
): RooCodeSettings | undefined {
	if (reasoning.status !== "not-requested" && reasoning.status !== "disabled" && reasoning.status !== "supported") {
		return undefined
	}

	const configuration: RooCodeSettings = {
		...current,
		apiProvider: "vscode-lm",
		vsCodeLmModelSelector: selector,
	}

	if (reasoning.status === "supported") {
		if (reasoning.appliedEffort === undefined) return undefined
		configuration.enableReasoningEffort = true
		configuration.reasoningEffort = reasoning.appliedEffort
	} else if (reasoning.status === "disabled") {
		configuration.enableReasoningEffort = false
		configuration.reasoningEffort = "disable"
	}

	return configuration
}

export type LiveCopilotPreflightErrorCode =
	| "invalid-options"
	| "discovery-unavailable"
	| "model-unavailable"
	| "model-selection-ambiguous"
	| "effort-unavailable"
	| "effort-unknown"
	| "authentication-required"
	| "authentication-unknown"
	| "configuration-failed"
	| "artifact-write-failed"

export type LiveCopilotPreflightError = {
	readonly code: LiveCopilotPreflightErrorCode
}

export type LiveCopilotSafeModelMetadata = {
	readonly vendor?: string
	readonly id?: string
	readonly family?: string
	readonly version?: string
	readonly name?: string
	readonly maxInputTokens?: number
}

export type LiveCopilotDiscoveryStatus = "not-run" | "available" | "failed"

export type LiveCopilotReadinessMetadata = {
	readonly status: "ready" | "provider-unavailable" | "timed-out" | "failed"
	readonly activation: "not-run" | "already-active" | "started" | "completed"
	readonly queryCount: number
	readonly modelChangeObserved: boolean
}

export type LiveCopilotDiscoveryMetadata = {
	readonly schemaVersion: 1
	readonly provider: "vscode-lm"
	readonly vendor: typeof LIVE_COPILOT_VENDOR
	readonly setup: boolean
	readonly status: LiveCopilotDiscoveryStatus
	readonly modelCount: number
	readonly availableModels: readonly LiveCopilotSafeModelMetadata[]
	readonly readiness?: LiveCopilotReadinessMetadata
	readonly error?: LiveCopilotPreflightError
	readonly artifact?: LiveCopilotArtifactMetadata
}

export type LiveCopilotAuthStatus = "available" | "required" | "unknown"
export type LiveCopilotAuthProbeMethod = "none" | "direct"
export type LiveCopilotAuthProbeStatus = "not-run" | "available" | "required" | "unknown"

export type LiveCopilotAuthProbeMetadata = {
	readonly method: LiveCopilotAuthProbeMethod
	readonly status: LiveCopilotAuthProbeStatus
}

export type LiveCopilotDiscoveryDependencies = {
	/** Stops readiness waits and prevents later probes/configuration writes. */
	readonly signal?: AbortSignal
	/** Test seam for the stable extension-host API; production loads vscode directly. */
	readonly loadVsCode?: () => Promise<VsCodeApi>
}

export type LiveCopilotAuthDependencies = LiveCopilotDiscoveryDependencies & {
	/** Stable ExtensionContext access is supplied by Alpha, not the sidecar. */
	readonly canSendRequest?: (model: LanguageModelChat) => boolean | undefined
}

export type LiveCopilotAuthMetadata = {
	readonly status: LiveCopilotAuthStatus
	readonly canSendRequest?: boolean
	readonly probe: LiveCopilotAuthProbeMetadata
}

export type LiveCopilotConfigurationStatus = "not-attempted" | "applied" | "failed"

export type LiveCopilotConfigurationMetadata = {
	readonly status: LiveCopilotConfigurationStatus
	readonly provider: "vscode-lm"
	readonly selector?: LiveCopilotModelSelector
	readonly reasoningEffort?: AlphaReasoningEffort
}

export type LiveCopilotArtifactMetadata = {
	readonly status: "not-requested" | "written" | "failed"
	readonly path?: string
	readonly error?: LiveCopilotPreflightError
}

export type LiveCopilotOptions = {
	readonly modelId: string
	readonly modelFamily?: string
	readonly reasoningEffort?: string
	readonly setup?: boolean
	readonly artifactsDir?: string
}

export type LiveCopilotPreflightMetadata = {
	readonly schemaVersion: 1
	readonly ok: boolean
	readonly ready: boolean
	readonly provider: "vscode-lm"
	readonly vendor: typeof LIVE_COPILOT_VENDOR
	readonly setup: boolean
	readonly requested: {
		readonly modelId: string
		readonly modelFamily?: string
		readonly reasoningEffort?: string
	}
	readonly discovery: {
		readonly status: "not-run" | "selected" | "model-unavailable" | "ambiguous" | "failed"
		readonly modelCount: number
		readonly availableModels: readonly LiveCopilotSafeModelMetadata[]
		readonly selectedModel?: LiveCopilotSafeModelMetadata
		readonly readiness?: LiveCopilotReadinessMetadata
	}
	readonly reasoning: LiveCopilotReasoningValidation
	readonly auth: LiveCopilotAuthMetadata
	readonly configuration: LiveCopilotConfigurationMetadata
	readonly error?: LiveCopilotPreflightError
	readonly artifact?: LiveCopilotArtifactMetadata
}

type VsCodeApi = typeof import("vscode")

type DiscoveryAttempt = { readonly readiness: LiveCopilotReadinessMetadata } & (
	| { readonly ok: true; readonly vscode: VsCodeApi; readonly models: readonly LanguageModelChat[] }
	| { readonly ok: false; readonly error: LiveCopilotPreflightError }
)

type ProbeResult = {
	readonly status: Exclude<LiveCopilotAuthProbeStatus, "not-run">
}

let artifactSequence = 0

export function sanitizeLiveCopilotModelMetadata(model: CopilotModelMetadata): LiveCopilotSafeModelMetadata {
	const safeModel: LiveCopilotSafeModelMetadata = {
		...(typeof model.vendor === "string" ? { vendor: model.vendor } : {}),
		...(typeof model.id === "string" ? { id: model.id } : {}),
		...(typeof model.family === "string" ? { family: model.family } : {}),
		...(typeof model.version === "string" ? { version: model.version } : {}),
		...(typeof model.name === "string" ? { name: model.name } : {}),
	}

	if (typeof model.maxInputTokens === "number" && Number.isFinite(model.maxInputTokens) && model.maxInputTokens > 0) {
		return { ...safeModel, maxInputTokens: Math.min(Math.floor(model.maxInputTokens), Number.MAX_SAFE_INTEGER) }
	}

	return safeModel
}

function createBasePreflightMetadata(options: LiveCopilotOptions): LiveCopilotPreflightMetadata {
	const setup = options.setup === true
	const requested: LiveCopilotPreflightMetadata["requested"] = {
		modelId: typeof options.modelId === "string" ? options.modelId : "",
		...(typeof options.modelFamily === "string" ? { modelFamily: options.modelFamily } : {}),
		...(typeof options.reasoningEffort === "string" ? { reasoningEffort: options.reasoningEffort } : {}),
	}

	return {
		schemaVersion: 1,
		ok: false,
		ready: false,
		provider: "vscode-lm",
		vendor: LIVE_COPILOT_VENDOR,
		setup,
		requested,
		discovery: { status: "not-run", modelCount: 0, availableModels: [] },
		reasoning:
			requested.reasoningEffort === undefined
				? { status: "not-requested" }
				: { status: "unknown", requested: requested.reasoningEffort },
		auth: { status: "unknown", probe: { method: "none", status: "not-run" } },
		configuration: { status: "not-attempted", provider: "vscode-lm" },
	}
}

function withPreflightError(
	metadata: LiveCopilotPreflightMetadata,
	error: LiveCopilotPreflightError,
): LiveCopilotPreflightMetadata {
	return { ...metadata, ok: false, ready: false, error }
}

function withTimeout<T>(value: PromiseLike<T>, timeoutMs: number, onTimeout?: () => void): Promise<T> {
	return new Promise<T>((resolvePromise, rejectPromise) => {
		let settled = false
		const timer = setTimeout(() => {
			if (settled) return
			settled = true
			try {
				onTimeout?.()
			} catch {
				// Cancellation is best effort; the bounded rejection still protects the caller.
			}
			rejectPromise(new Error("bounded-operation-timeout"))
		}, timeoutMs)

		Promise.resolve(value).then(
			(result) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				resolvePromise(result)
			},
			(error) => {
				if (settled) return
				settled = true
				clearTimeout(timer)
				rejectPromise(error)
			},
		)
	})
}

async function loadVsCode(): Promise<VsCodeApi> {
	return import("vscode")
}

async function discoverModels(dependencies: LiveCopilotDiscoveryDependencies = {}): Promise<DiscoveryAttempt> {
	const { signal } = dependencies
	signal?.throwIfAborted()
	let settled = false
	let subscription: { dispose(): void } | undefined
	let refresh: NodeJS.Immediate | undefined
	let timer: NodeJS.Timeout | undefined
	let cancel: (() => void) | undefined
	let activation: LiveCopilotReadinessMetadata["activation"] = "not-run"
	let queryCount = 0
	let modelChangeObserved = false
	const readiness = (status: LiveCopilotReadinessMetadata["status"]): LiveCopilotReadinessMetadata => ({
		status,
		activation,
		queryCount,
		modelChangeObserved,
	})

	try {
		return await new Promise<DiscoveryAttempt>((resolveAttempt, rejectAttempt) => {
			const finish = (attempt: DiscoveryAttempt) => {
				if (settled) return
				settled = true
				resolveAttempt(attempt)
			}
			const fail = (status: Exclude<LiveCopilotReadinessMetadata["status"], "ready"> = "failed") =>
				finish({ ok: false, error: { code: "discovery-unavailable" }, readiness: readiness(status) })
			cancel = () => {
				if (settled) return
				settled = true
				rejectAttempt(signal?.reason)
			}
			signal?.addEventListener("abort", cancel, { once: true })
			// One budget covers API loading, activation, in-flight queries, and event waits.
			timer = setTimeout(() => fail("timed-out"), LIVE_COPILOT_DISCOVERY_TIMEOUT_MS)

			const initialize = async () => {
				const vscode = await (dependencies.loadVsCode ?? loadVsCode)()
				if (settled) return
				if (
					!vscode.lm ||
					typeof vscode.lm.selectChatModels !== "function" ||
					typeof vscode.lm.onDidChangeChatModels !== "function" ||
					typeof vscode.extensions?.getExtension !== "function"
				) {
					fail("provider-unavailable")
					return
				}

				let initialized = false
				let inFlight = false
				let refreshNeeded = false
				const scheduleRefresh = () => {
					if (settled || !initialized || inFlight || !refreshNeeded || refresh) return
					// Coalesce events and yield so a noisy provider cannot starve cancellation/deadline timers.
					refresh = setImmediate(() => {
						refresh = undefined
						void query()
					})
				}
				const query = async () => {
					if (settled) return
					inFlight = true
					refreshNeeded = false
					queryCount = Math.min(queryCount + 1, Number.MAX_SAFE_INTEGER)
					try {
						const models = await vscode.lm.selectChatModels({ vendor: LIVE_COPILOT_VENDOR })
						if (settled) return
						inFlight = false
						if (!Array.isArray(models)) {
							fail()
						} else if (models.length > 0) {
							finish({ ok: true, vscode, models, readiness: readiness("ready") })
						} else {
							scheduleRefresh()
						}
					} catch {
						// A provider error is not a readiness event and must not trigger retries.
						fail()
					}
				}

				// Subscribe before activation/first query; changes during either must not be lost.
				subscription = vscode.lm.onDidChangeChatModels(() => {
					if (settled) return
					modelChangeObserved = true
					refreshNeeded = true
					scheduleRefresh()
				})
				const provider = vscode.extensions.getExtension("GitHub.copilot-chat")
				if (!provider) {
					fail("provider-unavailable")
					return
				}
				if (provider.isActive) {
					activation = "already-active"
				} else {
					activation = "started"
					await provider.activate()
					if (settled) return
					activation = "completed"
				}
				initialized = true
				await query()
			}
			void initialize().catch(() => fail())
		})
	} finally {
		// VS Code activation/select promises cannot be cancelled. Ignore their late settlements.
		settled = true
		if (timer) clearTimeout(timer)
		if (refresh) clearImmediate(refresh)
		if (cancel) signal?.removeEventListener("abort", cancel)
		subscription?.dispose()
	}
}

function mapDiscoveryMetadata(attempt: DiscoveryAttempt, setup: boolean): LiveCopilotDiscoveryMetadata {
	if (!attempt.ok) {
		return {
			schemaVersion: 1,
			provider: "vscode-lm",
			vendor: LIVE_COPILOT_VENDOR,
			setup,
			status: "failed",
			modelCount: 0,
			availableModels: [],
			readiness: attempt.readiness,
			error: attempt.error,
		}
	}

	return {
		schemaVersion: 1,
		provider: "vscode-lm",
		vendor: LIVE_COPILOT_VENDOR,
		setup,
		status: "available",
		modelCount: attempt.models.length,
		availableModels: attempt.models.map(sanitizeLiveCopilotModelMetadata),
		readiness: attempt.readiness,
	}
}

function createArtifactPath(artifactsDir: string): string {
	return join(resolve(artifactsDir), LIVE_COPILOT_ARTIFACT_FILENAME)
}

async function writeArtifactAtomically(path: string, metadata: object): Promise<void> {
	const temporaryPath = `${path}.${process.pid}.${Date.now()}.${artifactSequence++}.tmp`
	await mkdir(resolve(path, ".."), { recursive: true })
	try {
		await writeFile(temporaryPath, `${JSON.stringify(metadata, null, 2)}\n`, { encoding: "utf8", flag: "wx" })
		await rename(temporaryPath, path)
	} finally {
		await unlink(temporaryPath).catch(() => undefined)
	}
}

async function finalizeDiscoveryArtifact(
	metadata: LiveCopilotDiscoveryMetadata,
	artifactsDir: string | undefined,
): Promise<LiveCopilotDiscoveryMetadata> {
	if (typeof artifactsDir !== "string" || artifactsDir.length === 0) {
		return { ...metadata, artifact: { status: "not-requested" } }
	}

	const path = createArtifactPath(artifactsDir)
	const writtenMetadata: LiveCopilotDiscoveryMetadata = {
		...metadata,
		artifact: { status: "written", path },
	}

	try {
		await writeArtifactAtomically(path, writtenMetadata)
		return writtenMetadata
	} catch {
		return {
			...metadata,
			artifact: { status: "failed", path, error: { code: "artifact-write-failed" } },
		}
	}
}

async function finalizePreflightArtifact(
	metadata: LiveCopilotPreflightMetadata,
	artifactsDir: string | undefined,
): Promise<LiveCopilotPreflightMetadata> {
	if (typeof artifactsDir !== "string" || artifactsDir.length === 0) {
		return { ...metadata, artifact: { status: "not-requested" } }
	}

	const path = createArtifactPath(artifactsDir)
	const writtenMetadata: LiveCopilotPreflightMetadata = {
		...metadata,
		artifact: { status: "written", path },
	}

	try {
		await writeArtifactAtomically(path, writtenMetadata)
		return writtenMetadata
	} catch {
		return {
			...metadata,
			artifact: { status: "failed", path, error: { code: "artifact-write-failed" } },
		}
	}
}

export function readAuthMetadata(
	dependencies: LiveCopilotAuthDependencies,
	model: LanguageModelChat,
): LiveCopilotAuthMetadata {
	if (typeof dependencies.canSendRequest !== "function") {
		return { status: "unknown", probe: { method: "none", status: "not-run" } }
	}

	try {
		const canSendRequest = dependencies.canSendRequest(model)
		if (canSendRequest === true) {
			return { status: "available", canSendRequest: true, probe: { method: "none", status: "not-run" } }
		}
		if (canSendRequest === false) {
			return { status: "required", canSendRequest: false, probe: { method: "none", status: "not-run" } }
		}
		return { status: "unknown", probe: { method: "none", status: "not-run" } }
	} catch {
		return { status: "unknown", probe: { method: "none", status: "not-run" } }
	}
}

function isPermissionError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false

	const value = error as { code?: unknown; name?: unknown }
	const code = typeof value.code === "string" ? value.code.toLowerCase() : ""
	const name = typeof value.name === "string" ? value.name.toLowerCase() : ""
	return (
		code.includes("nopermissions") ||
		code.includes("permission") ||
		name.includes("nopermissions") ||
		name.includes("permission")
	)
}

async function closeResponseStream(response: LanguageModelChatResponse): Promise<void> {
	try {
		const iterator = response.stream[Symbol.asyncIterator]()
		if (typeof iterator.return === "function") {
			await withTimeout(Promise.resolve(iterator.return()), LIVE_COPILOT_STREAM_CLOSE_TIMEOUT_MS)
		}
	} catch {
		// The setup probe has no response payload to retain; close is best effort and bounded.
	}
}

/**
 * Run the only direct request this sidecar can make. The result is recorded as
 * a direct probe, not as a normal Alpha task request. The caller must invoke
 * configureLiveCopilot({ setup: true }) from a user-gesture command because
 * VS Code may show Copilot consent for the first request.
 */
async function runSetupProbe(vscode: VsCodeApi, model: LanguageModelChat, signal?: AbortSignal): Promise<ProbeResult> {
	signal?.throwIfAborted()
	if (typeof model.sendRequest !== "function") return { status: "unknown" }

	const cancellation = new vscode.CancellationTokenSource()
	const cancel = () => cancellation.cancel()
	signal?.addEventListener("abort", cancel, { once: true })
	let requestFinished = false
	let response: LanguageModelChatResponse | undefined

	try {
		const requestPromise = Promise.resolve(
			model.sendRequest(
				[vscode.LanguageModelChatMessage.User("Alpha live Copilot preflight.")],
				{ justification: "Verify Alpha access to the explicitly selected Copilot model." },
				cancellation.token,
			),
		).then((candidate) => {
			response = candidate
			if (requestFinished) void closeResponseStream(candidate)
			return candidate
		})

		response = await withTimeout(requestPromise, LIVE_COPILOT_SETUP_REQUEST_TIMEOUT_MS, () => cancellation.cancel())
		return { status: "available" }
	} catch (error) {
		return { status: isPermissionError(error) ? "required" : "unknown" }
	} finally {
		requestFinished = true
		signal?.removeEventListener("abort", cancel)
		cancellation.cancel()
		if (response) await closeResponseStream(response)
		cancellation.dispose()
	}
}

async function resolveAuth(
	vscode: VsCodeApi,
	model: LanguageModelChat,
	setup: boolean,
	dependencies: LiveCopilotAuthDependencies,
): Promise<LiveCopilotAuthMetadata> {
	const initial = readAuthMetadata(dependencies, model)
	if (!setup || initial.status === "available") return initial

	const probe = await runSetupProbe(vscode, model, dependencies.signal)
	// The model object comes from the test-sidecar VS Code API. Its direct
	// request can have a different extension identity from Alpha, so it never
	// proves Alpha consent. Re-read the injected Alpha context after the probe.
	const alphaAccess = readAuthMetadata(dependencies, model)

	return {
		status: alphaAccess.status,
		...(alphaAccess.canSendRequest !== undefined ? { canSendRequest: alphaAccess.canSendRequest } : {}),
		probe: { method: "direct", status: probe.status },
	}
}

/** Discover current Copilot models without selecting a model or making a request. */
export async function discoverLiveCopilotModels(
	options: { readonly setup?: boolean; readonly artifactsDir?: string } = {},
	dependencies: LiveCopilotDiscoveryDependencies = {},
): Promise<LiveCopilotDiscoveryMetadata> {
	const attempt = await discoverModels(dependencies)
	const metadata = mapDiscoveryMetadata(attempt, options.setup === true)
	return finalizeDiscoveryArtifact(metadata, options.artifactsDir)
}

/**
 * Discover, validate, optionally consent-probe, and configure one exact live
 * Copilot model. The return value is safe to persist as live-copilot-preflight.json.
 * It never includes prompts, response text, credentials, or provider errors.
 */
export async function configureLiveCopilot(
	api: RooCodeAPI,
	options: LiveCopilotOptions,
	dependencies: LiveCopilotAuthDependencies = {},
): Promise<LiveCopilotPreflightMetadata> {
	dependencies.signal?.throwIfAborted()
	let metadata = createBasePreflightMetadata(options)

	if (!api || typeof api.setConfiguration !== "function" || typeof api.getConfiguration !== "function") {
		return finalizePreflightArtifact(
			withPreflightError(metadata, { code: "invalid-options" }),
			options.artifactsDir,
		)
	}

	const attempt = await discoverModels(dependencies)
	dependencies.signal?.throwIfAborted()
	if (!attempt.ok) {
		metadata = {
			...metadata,
			discovery: { status: "failed", modelCount: 0, availableModels: [], readiness: attempt.readiness },
		}
		return finalizePreflightArtifact(withPreflightError(metadata, attempt.error), options.artifactsDir)
	}

	const availableModels = attempt.models.map(sanitizeLiveCopilotModelMetadata)
	const selection = validateExactCopilotModelSelection(attempt.models, {
		modelId: metadata.requested.modelId,
		...(metadata.requested.modelFamily !== undefined ? { modelFamily: metadata.requested.modelFamily } : {}),
	})

	if (!selection.ok) {
		const error: LiveCopilotPreflightError =
			selection.code === "model-selection-ambiguous"
				? { code: "model-selection-ambiguous" }
				: { code: "model-unavailable" }
		metadata = {
			...metadata,
			discovery: {
				status: selection.code === "model-selection-ambiguous" ? "ambiguous" : "model-unavailable",
				modelCount: attempt.models.length,
				availableModels,
				readiness: attempt.readiness,
			},
		}
		return finalizePreflightArtifact(withPreflightError(metadata, error), options.artifactsDir)
	}

	const safeSelectedModel = sanitizeLiveCopilotModelMetadata(selection.model)
	const reasoning = validateRequestedReasoningEffort(selection.model, metadata.requested.reasoningEffort)
	metadata = {
		...metadata,
		discovery: {
			status: "selected",
			modelCount: attempt.models.length,
			availableModels,
			selectedModel: safeSelectedModel,
			readiness: attempt.readiness,
		},
		reasoning,
	}

	if (reasoning.status === "unsupported") {
		return finalizePreflightArtifact(
			withPreflightError(metadata, { code: "effort-unavailable" }),
			options.artifactsDir,
		)
	}
	if (reasoning.status === "unknown") {
		return finalizePreflightArtifact(withPreflightError(metadata, { code: "effort-unknown" }), options.artifactsDir)
	}

	const auth = await resolveAuth(attempt.vscode, selection.model, options.setup === true, dependencies)
	dependencies.signal?.throwIfAborted()
	metadata = { ...metadata, auth }

	let currentConfiguration: RooCodeSettings
	try {
		currentConfiguration = api.getConfiguration()
	} catch {
		return finalizePreflightArtifact(
			withPreflightError(
				{
					...metadata,
					configuration: { status: "failed", provider: "vscode-lm", selector: selection.selector },
				},
				{ code: "configuration-failed" },
			),
			options.artifactsDir,
		)
	}

	const configuration = buildLiveCopilotConfiguration(currentConfiguration, selection.selector, reasoning)
	if (!configuration) {
		return finalizePreflightArtifact(
			withPreflightError(
				{
					...metadata,
					configuration: { status: "not-attempted", provider: "vscode-lm", selector: selection.selector },
				},
				{ code: "invalid-options" },
			),
			options.artifactsDir,
		)
	}

	try {
		await api.setConfiguration(configuration)
	} catch {
		return finalizePreflightArtifact(
			withPreflightError(
				{
					...metadata,
					configuration: { status: "failed", provider: "vscode-lm", selector: selection.selector },
				},
				{ code: "configuration-failed" },
			),
			options.artifactsDir,
		)
	}

	const appliedEffort = reasoning.appliedEffort
	const configurationMetadata: LiveCopilotConfigurationMetadata = {
		status: "applied",
		provider: "vscode-lm",
		selector: selection.selector,
		...(appliedEffort !== undefined ? { reasoningEffort: appliedEffort } : {}),
	}
	const ready = auth.status === "available"
	const finalMetadata: LiveCopilotPreflightMetadata = {
		...metadata,
		ok: ready,
		ready,
		configuration: configurationMetadata,
		...(ready
			? {}
			: {
					error:
						auth.status === "required"
							? ({ code: "authentication-required" } satisfies LiveCopilotPreflightError)
							: ({ code: "authentication-unknown" } satisfies LiveCopilotPreflightError),
				}),
	}

	return finalizePreflightArtifact(finalMetadata, options.artifactsDir)
}
