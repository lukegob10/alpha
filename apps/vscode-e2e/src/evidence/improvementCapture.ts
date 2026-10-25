import * as fs from "node:fs/promises"
import * as path from "node:path"
import { pathToFileURL } from "node:url"
import { isDeepStrictEqual } from "node:util"

import { readBounded, rejectSymlinkComponents, requireEvidenceRoot, requireEvidenceRun } from "./paths"
import { TestRunError } from "../runFailure"
import type { ExtensionTestRunOptions, ExtensionTestRunResult } from "../runTest"
import type { TestProfile } from "../testProfile"
import { runOwnedProcess } from "../campaign/ownedProcess"

const CAPTURE_RESULT_KIND = "alpha-native-host-capture-result"

export interface ImprovementCaptureState {
	hostRunId: string
	runDirectory: string
	workspace: string
	contextPath: string
	contextDigest: string
	userDataDir: string
}

export interface ImprovementCaptureResult {
	status: "captured" | "incomplete" | "failed"
	contextPath: string
	contextDigest: string
	captureResultPath: string
	bundlePath?: string
	artifactsRoot?: string
}

/** A source-only adapter keeps the extension host and the normal privacy projection independent of evals. */
export type ImprovementCaptureInvoker = (
	phase: "prepare" | "finalize",
	inputPath: string,
	signal?: AbortSignal,
) => Promise<unknown>

/** Sanitized helper failures retain the cleanup proof needed by the profile lease owner. */
export class ImprovementCaptureHelperError extends TestRunError {
	constructor(
		readonly cleanupVerified: boolean,
		cancelled = false,
	) {
		super(
			cancelled ? "host-cancelled" : "evidence-failed",
			cancelled
				? "Native improvement evidence capture was cancelled"
				: "Native improvement evidence capture did not complete",
		)
	}
}

export function validateImprovementCaptureOptions(options: ExtensionTestRunOptions): void {
	if (options.improvementEvidence !== undefined && typeof options.improvementEvidence !== "boolean")
		throw new TestRunError("invalid-options", "Improvement evidence must be explicitly enabled")
	if (!options.improvementEvidence) {
		if (options.improvementTaskId !== undefined)
			throw new TestRunError("invalid-options", "A source task requires explicit improvement evidence")
		return
	}
	if (
		options.setup ||
		options.scenarioId !== "problem-solving-attempt" ||
		(options.scenarioPhase !== undefined && options.scenarioPhase !== "run") ||
		(options.testFile !== undefined && options.testFile !== "workflow.test") ||
		!options.profileDir ||
		!options.workspace ||
		!options.artifactsDir ||
		!["scripted", "live-copilot"].includes(options.providerMode) ||
		options.vscodeVersion !== "1.138.0" ||
		typeof options.improvementTaskId !== "string" ||
		options.improvementTaskId.length > 200 ||
		!/^[a-z0-9][a-z0-9._/-]*(?:@[1-9]\d*)?$/.test(options.improvementTaskId)
	)
		throw new TestRunError(
			"invalid-options",
			"Improvement evidence requires VS Code 1.138.0, one public problem-solving task and explicit owned run paths",
		)
	// This offline plan exercises real tools and failed validation; it does not solve the source benchmark.
	if (
		options.providerMode === "scripted" &&
		!["repo-cache-invalidation", "repo-cache-invalidation@1"].includes(options.improvementTaskId)
	)
		throw new TestRunError("invalid-options", "The scripted capture contract requires repo-cache-invalidation@1")
}

async function writePrivateJson(file: string, value: unknown): Promise<void> {
	await rejectSymlinkComponents(file)
	await fs.writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 })
}

async function verifyHelperProtocol(phase: "prepare" | "finalize", inputPath: string, value: unknown): Promise<void> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid helper protocol")
	const result = value as Record<string, unknown>
	const input = JSON.parse((await readBounded(inputPath, 128 * 1024)).toString("utf8"))
	const directory = path.dirname(inputPath)
	if (phase === "prepare") {
		const contextPath = path.join(directory, "context.json")
		if (
			result.contextPath !== contextPath ||
			typeof result.contextDigest !== "string" ||
			!/^sha256:[a-f0-9]{64}$/.test(result.contextDigest)
		)
			throw new Error("Invalid helper context")
		const context = JSON.parse((await readBounded(contextPath, 2 * 1024 * 1024)).toString("utf8"))
		if (
			context.digest !== result.contextDigest ||
			context.hostRunId !== input.hostRunId ||
			context.kind !== "alpha-native-host-capture-context" ||
			context.scope !== "owned-native-host-public-task"
		)
			throw new Error("Invalid helper context proof")
		return
	}
	const receiptPath = path.join(directory, "capture-result.json")
	const receipt = JSON.parse((await readBounded(receiptPath, 128 * 1024)).toString("utf8"))
	if (
		!isDeepStrictEqual(result, receipt) ||
		result.schemaVersion !== 1 ||
		result.kind !== CAPTURE_RESULT_KIND ||
		!["captured", "incomplete", "failed"].includes(String(result.status)) ||
		result.contextPath !== input.contextPath ||
		result.contextDigest !== input.expectedContextDigest ||
		result.captureResultPath !== receiptPath ||
		(result.bundlePath !== undefined && result.bundlePath !== path.join(directory, "bundle.json")) ||
		(result.artifactsRoot !== undefined && result.artifactsRoot !== path.join(directory, "artifacts"))
	)
		throw new Error("Invalid helper terminal proof")
}

export async function invokeImprovementCapture(
	phase: "prepare" | "finalize",
	inputPath: string,
	signal?: AbortSignal,
	ports: { runProcess?: typeof runOwnedProcess } = {},
): Promise<unknown> {
	if (signal?.aborted) throw new ImprovementCaptureHelperError(true, true)
	const repositoryRoot = path.resolve(__dirname, "../../../..")
	const moduleUrl = pathToFileURL(path.join(repositoryRoot, "packages/evals/src/evidence/nativeHostCapture.ts")).href
	const script = [
		"const [moduleUrl, phase, inputPath] = process.argv.slice(1)",
		'const { readFile } = await import("node:fs/promises")',
		"const capture = await import(moduleUrl)",
		'const input = JSON.parse(await readFile(inputPath, "utf8"))',
		'const method = phase === "prepare" ? "prepareNativeHostCapture" : "finalizeNativeHostCapture"',
		"const cancellation = new AbortController()",
		"const cancel = () => cancellation.abort()",
		'process.once("SIGTERM", cancel)',
		'process.once("SIGINT", cancel)',
		"const signal = AbortSignal.any([cancellation.signal, AbortSignal.timeout(55_000)])",
		'try { process.stdout.write(JSON.stringify(await capture[method](input, { signal }))) } finally { process.removeListener("SIGTERM", cancel); process.removeListener("SIGINT", cancel) }',
	].join(";\n")
	const deadline = new AbortController()
	const timer = setTimeout(() => deadline.abort(), 60_000)
	const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal
	let cleanupVerified = false
	try {
		const result = await (ports.runProcess ?? runOwnedProcess)(
			{
				executable: process.execPath,
				args: [
					"--import",
					pathToFileURL(require.resolve("tsx")).href,
					"--input-type=module",
					"--eval",
					script,
					moduleUrl,
					phase,
					inputPath,
				],
				cwd: repositoryRoot,
			},
			{ signal: combined, maxOutputBytes: 64 * 1024, killGraceMs: 1_000 },
		)
		cleanupVerified = result.cleanupVerified
		if (combined.aborted || result.exitCode !== 0 || result.signal !== null || result.outputTruncated)
			throw new ImprovementCaptureHelperError(cleanupVerified, signal?.aborted)
		const value: unknown = JSON.parse(result.stdout)
		// Ordinary Windows close alone cannot prove a tree exit. Only the complete trusted helper protocol permits it.
		await verifyHelperProtocol(phase, inputPath, value)
		if (combined.aborted) throw new ImprovementCaptureHelperError(cleanupVerified, signal?.aborted)
		return value
	} catch (error) {
		if (error instanceof ImprovementCaptureHelperError) throw error
		// Child diagnostics can contain source or provider text. The private capture receipt owns those details.
		throw new ImprovementCaptureHelperError(cleanupVerified, signal?.aborted)
	} finally {
		clearTimeout(timer)
	}
}

export async function prepareImprovementCapture(
	input: {
		options: ExtensionTestRunOptions
		profile: TestProfile
		hostRunId: string
		runDirectory: string
		extensionId: string
		extensionRoot: string
		startedAt: string
	},
	invoke: ImprovementCaptureInvoker = invokeImprovementCapture,
): Promise<ImprovementCaptureState | undefined> {
	validateImprovementCaptureOptions(input.options)
	if (!input.options.improvementEvidence) return undefined
	const root = await requireEvidenceRoot(input.profile.artifactsDir)
	if ((await requireEvidenceRun(root, input.hostRunId)) !== path.resolve(input.runDirectory))
		throw new TestRunError("evidence-failed", "Improvement evidence must belong to this run")
	const directory = path.join(input.runDirectory, "improvement")
	await fs.mkdir(directory, { mode: 0o700 })
	await rejectSymlinkComponents(directory)
	const repositoryRoot = path.resolve(__dirname, "../../../..")
	const prepareInput = {
		schemaVersion: 1,
		kind: "alpha-native-host-capture-prepare",
		hostRunId: input.hostRunId,
		runDirectory: input.runDirectory,
		workspace: input.profile.workspace,
		catalogRoot: path.join(repositoryRoot, "evals"),
		taskId: input.options.improvementTaskId,
		extensionRoot: input.extensionRoot,
		extensionId: input.extensionId,
		userDataDir: input.profile.userDataDir,
		repositoryRoot,
		startedAt: input.startedAt,
	}
	const inputPath = path.join(directory, "prepare-input.json")
	await writePrivateJson(inputPath, prepareInput)
	const prepared = await invoke("prepare", inputPath, input.options.signal)
	if (!prepared || typeof prepared !== "object") throw new TestRunError("evidence-failed", "Invalid capture context")
	const result = prepared as { contextPath?: unknown; contextDigest?: unknown }
	const contextPath = path.join(directory, "context.json")
	if (
		result.contextPath !== contextPath ||
		typeof result.contextDigest !== "string" ||
		!/^sha256:[a-f0-9]{64}$/.test(result.contextDigest)
	)
		throw new TestRunError("evidence-failed", "Capture context does not belong to this attempt")
	await readBounded(contextPath, 2 * 1024 * 1024)
	return {
		hostRunId: input.hostRunId,
		runDirectory: input.runDirectory,
		workspace: input.profile.workspace,
		userDataDir: input.profile.userDataDir,
		contextPath,
		contextDigest: result.contextDigest,
	}
}

export async function finalizeImprovementCapture(
	input: {
		state: ImprovementCaptureState
		result: ExtensionTestRunResult
		storagePath?: string
		logsPath?: string
		taskIds: string[]
		workflowResultPath: string
		signal?: AbortSignal
	},
	invoke: ImprovementCaptureInvoker = invokeImprovementCapture,
): Promise<ImprovementCaptureResult> {
	const { state, result } = input
	if (
		result.runId !== state.hostRunId ||
		result.artifactsDir !== state.runDirectory ||
		result.workspace !== state.workspace ||
		result.userDataDir !== state.userDataDir
	)
		throw new TestRunError("evidence-failed", "Improvement evidence attempt identity changed")
	const directory = path.join(state.runDirectory, "improvement")
	const finishedAt = new Date().toISOString()
	const observed = {
		status: result.status,
		failure: result.failure,
		execution: result.execution,
		hostExitObserved: result.hostExitObserved,
		hostCleanupVerified: result.hostCleanupVerified,
		ownershipGate: result.ownershipGate,
		actualVSCodeVersion: result.actualVSCodeVersion,
		actualModelId: result.actualModelId,
		actualReasoningEffort: result.actualReasoningEffort,
		providerMode: result.providerMode,
		providerIdentity: result.providerIdentity,
		hostCaptureClosure: result.hostCaptureClosure,
		userDataDir: result.userDataDir,
	}
	await writePrivateJson(path.join(directory, "host-outcome.json"), {
		schemaVersion: 1,
		kind: "alpha-native-host-outcome",
		hostRunId: state.hostRunId,
		contextPath: state.contextPath,
		expectedContextDigest: state.contextDigest,
		finishedAt,
		result: observed,
	})
	const inputPath = path.join(directory, "finalize-input.json")
	await writePrivateJson(inputPath, {
		schemaVersion: 1,
		kind: "alpha-native-host-capture-finalize",
		hostRunId: state.hostRunId,
		contextPath: state.contextPath,
		expectedContextDigest: state.contextDigest,
		runDirectory: state.runDirectory,
		workspace: state.workspace,
		storagePath: input.storagePath,
		logsPath: input.logsPath,
		taskIds: input.taskIds,
		workflowResultPath: input.workflowResultPath,
		finishedAt,
		result: observed,
	})
	const finalized = await invoke("finalize", inputPath, input.signal)
	const receipt = JSON.parse(
		(await readBounded(path.join(directory, "capture-result.json"), 128 * 1024)).toString("utf8"),
	)
	if (
		!isDeepStrictEqual(finalized, receipt) ||
		receipt.schemaVersion !== 1 ||
		receipt.kind !== CAPTURE_RESULT_KIND ||
		!["captured", "incomplete", "failed"].includes(receipt.status) ||
		receipt.contextPath !== state.contextPath ||
		receipt.contextDigest !== state.contextDigest ||
		receipt.captureResultPath !== path.join(directory, "capture-result.json") ||
		(receipt.bundlePath !== undefined && receipt.bundlePath !== path.join(directory, "bundle.json")) ||
		(receipt.artifactsRoot !== undefined && receipt.artifactsRoot !== path.join(directory, "artifacts"))
	)
		throw new TestRunError("evidence-failed", "Improvement capture receipt does not belong to this attempt")
	return {
		status: receipt.status,
		contextPath: receipt.contextPath,
		contextDigest: receipt.contextDigest,
		captureResultPath: receipt.captureResultPath,
		...(receipt.bundlePath ? { bundlePath: receipt.bundlePath } : {}),
		...(receipt.artifactsRoot ? { artifactsRoot: receipt.artifactsRoot } : {}),
	}
}
