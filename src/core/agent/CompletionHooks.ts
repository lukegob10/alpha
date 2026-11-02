import { spawn } from "node:child_process"
import crypto from "node:crypto"
import { t } from "../../i18n"
import { terminateProcessTree } from "../../utils/processTree"
import type { LifecycleHookTarget } from "./LifecycleHookTargets"
import { MAX_HOOK_OUTPUT_BYTES, preserveHookOutput } from "./HookOutput"
import {
	DEFAULT_HOOK_TIMEOUT_MS,
	selectLifecycleHookCommands,
	type CompletionHookCommand,
	type CompletionHookConfig,
	type CompletionHookMcp,
	type LifecycleHookHandler,
} from "./LifecycleHookConfig"

export type { LifecycleHookTarget } from "./LifecycleHookTargets"
export { readCompletionHookConfig } from "./LifecycleHookConfig"
export type { CompletionHookCommand, CompletionHookConfig } from "./LifecycleHookConfig"

const MAX_HOOKS = 8
const MAX_CONCURRENT_HOOKS = 4
// Join the shared helper's bounded discovery/termination and the owned pipe close.
const PROCESS_CLOSE_TIMEOUT_MS = 11_000

export class HookCommandCleanupError extends Error {
	constructor(
		readonly event: LifecycleHookTarget,
		readonly retryCleanup: () => Promise<void>,
		cause: unknown,
	) {
		super(`${event} hook process cleanup could not be confirmed`, { cause })
		this.name = "HookCommandCleanupError"
	}
}

export type CompletionHookTarget = "Stop" | "SubagentStop"

type LifecycleHookBaseRequest = Omit<
	CompletionHookRequest,
	"hook_event_name" | "stop_hook_active" | "last_assistant_message"
>

export type LifecycleHookPayload =
	| { hook_event_name: "PreCompact" | "PostCompact"; trigger: "manual" | "auto" }
	| { hook_event_name: "Interrupt" }
	| { hook_event_name: "SessionEnd"; reason: "other" }
	| { hook_event_name: "PermissionRequest"; tool_name: string; tool_input: Record<string, unknown> }
	| {
			hook_event_name: "SessionStart"
			source: "startup" | "resume" | "clear" | "compact" | "fork"
	  }
	| { hook_event_name: "SubagentStart"; agent_id: string; agent_type: string }
	| { hook_event_name: "UserPromptSubmit"; prompt: string }
	| {
			hook_event_name: "PreToolUse"
			tool_name: string
			tool_use_id: string
			tool_input: Record<string, unknown>
	  }
	| {
			hook_event_name: "PostToolUse"
			tool_name: string
			tool_use_id: string
			tool_input: Record<string, unknown>
			tool_response: unknown
	  }

export type LifecycleHookRequest = CompletionHookRequest | (LifecycleHookBaseRequest & LifecycleHookPayload)

function isCompletionHookRequest(request: LifecycleHookRequest): request is CompletionHookRequest {
	return request.hook_event_name === "Stop" || request.hook_event_name === "SubagentStop"
}

export interface LifecycleHookOutcome {
	warnings: string[]
	additionalContext?: CompletionHookPromptFragment[]
	shouldStop?: boolean
	stopReason?: string
	/** Actual command-run identity for a durable, nonhuman rejected-input receipt. */
	stopProvenance?: CompletionHookPromptProvenance
	shouldBlock?: boolean
	blockReason?: string
	feedbackMessage?: string
	/** Effective arguments still require the scheduler's ordinary policy, validation, and approvals. */
	updatedInput?: Record<string, unknown>
}

export interface CompletionHookRequest {
	hook_event_name: CompletionHookTarget
	session_id: string
	turn_id: string
	cwd: string
	model: string
	stop_hook_active: boolean
	last_assistant_message: string
	permission_mode: string
	transcript_path: string | null
	agent_transcript_path?: string | null
	agent_id?: string
	agent_type?: string
}

export interface CompletionHookOutcome {
	prompt?: string
	fragments?: CompletionHookPromptFragment[]
	shouldStop?: boolean
	stopReason?: string
	warnings: string[]
}

export interface CompletionHookPromptFragment {
	hook_run_id: string
	text: string
}

export interface CompletionHookPromptProvenance {
	event: LifecycleHookTarget
	fragments: CompletionHookPromptFragment[]
}

export interface CompletionHookRuntimeOptions {
	/** Background hooks can report context and warnings, but cannot steer live control flow. */
	advisory?: boolean
	executeMcp?: (
		hook: CompletionHookMcp,
		request: LifecycleHookRequest,
		signal: AbortSignal,
	) => Promise<HookCommandResult>
	scheduleAsync?: (event: LifecycleHookTarget, run: (signal: AbortSignal) => Promise<LifecycleHookOutcome>) => boolean
}

export interface HookCommandResult {
	exitCode: number | null
	stdout: string
	stderr: string
	failure?: string
}

async function runCommand(
	hook: CompletionHookCommand,
	request: LifecycleHookRequest,
	signal: AbortSignal,
): Promise<HookCommandResult> {
	if (signal.aborted) return { exitCode: null, stdout: "", stderr: "", failure: "cancelled" }
	let input: string
	try {
		// Match event-specific stdin contracts while retaining the legacy Stop input.
		const omitted =
			request.hook_event_name === "SessionStart"
				? ["turn_id"]
				: request.hook_event_name === "PreCompact" || request.hook_event_name === "PostCompact"
					? ["permission_mode", "agent_transcript_path"]
					: []
		const payload =
			request.hook_event_name === "SessionEnd"
				? {
						session_id: request.session_id,
						transcript_path: request.transcript_path,
						cwd: request.cwd,
						hook_event_name: request.hook_event_name,
						reason: request.reason,
					}
				: Object.fromEntries(Object.entries(request).filter(([key]) => !omitted.includes(key)))
		input = JSON.stringify(payload)
	} catch {
		return { exitCode: null, stdout: "", stderr: "", failure: "received non-serializable input" }
	}
	return new Promise((resolve, reject) => {
		let settled = false
		const stdoutChunks: Buffer[] = []
		const stderrChunks: Buffer[] = []
		let outputBytes = 0
		let failure: string | undefined
		let terminating: Promise<void> | undefined
		let exited = false
		let treeTerminated = false
		let treeTermination: Promise<void> | undefined
		let activeCleanup: Promise<void> | undefined
		let cleanupFailure: unknown
		let resolveClosed!: () => void
		const processClosed = new Promise<void>((resolve) => (resolveClosed = resolve))
		let child: ReturnType<typeof spawn>
		try {
			child = spawn(hook.command, hook.args ?? [], {
				cwd: request.cwd,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
				shell: false,
				detached: process.platform !== "win32",
			})
		} catch {
			resolve({ exitCode: null, stdout: "", stderr: "", failure: "could not start" })
			return
		}
		const finish = (exitCode: number | null) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			signal.removeEventListener("abort", cancel)
			// Decode complete, bounded streams so chunk boundaries cannot corrupt UTF-8.
			const stdout = failure === undefined ? Buffer.concat(stdoutChunks).toString("utf8") : ""
			const stderr = failure === undefined ? Buffer.concat(stderrChunks).toString("utf8") : ""
			stdoutChunks.length = 0
			stderrChunks.length = 0
			resolve({ exitCode, stdout, stderr, failure })
		}
		const performCleanup = async (): Promise<void> => {
			if (!child.pid) return
			let closeTimeout: ReturnType<typeof setTimeout> | undefined
			try {
				const closeDeadline = new Promise<never>((_, fail) => {
					closeTimeout = setTimeout(
						() => fail(new Error("Timed out waiting for the hook process to close")),
						PROCESS_CLOSE_TIMEOUT_MS,
					)
				})
				if (!treeTerminated && !treeTermination) {
					// Once the captured root exits, its PID can be reused. A failed tree
					// observation cannot be repaired by signalling that numeric PID again.
					if (exited) throw cleanupFailure ?? new Error("Hook exited before its process tree was stopped")
					treeTermination = terminateProcessTree([child.pid], {
						detachedProcessGroup: process.platform !== "win32" ? child.pid : undefined,
					}).then(
						() => {
							treeTerminated = true
						},
						(error) => {
							treeTermination = undefined
							throw error
						},
					)
				}
				await Promise.race([Promise.all([treeTermination, processClosed]), closeDeadline])
			} catch (error) {
				cleanupFailure = error
				throw error
			} finally {
				clearTimeout(closeTimeout)
			}
		}
		const cleanup = (): Promise<void> => {
			activeCleanup ??= performCleanup().finally(() => (activeCleanup = undefined))
			return activeCleanup
		}
		const stop = (reason: string) => {
			if (settled || failure !== undefined || terminating) return
			failure = reason
			clearTimeout(timeout)
			stdoutChunks.length = 0
			stderrChunks.length = 0
			terminating = cleanup()
			void terminating.then(
				() => finish(null),
				(error) => {
					settled = true
					signal.removeEventListener("abort", cancel)
					// The error retains this original child and its retryable cleanup.
					// Late close/error listeners remain owned until physical settlement.
					reject(new HookCommandCleanupError(request.hook_event_name, cleanup, error))
				},
			)
		}
		const cancel = () => stop("cancelled")
		const timeout = setTimeout(() => {
			stop("timed out")
		}, hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS)
		signal.addEventListener("abort", cancel, { once: true })
		const collect = (chunks: Buffer[], chunk: Buffer) => {
			// Latch failure before termination: Windows taskkill may still be pending or starting.
			if (settled || failure !== undefined || terminating || chunk.length === 0) return
			if (chunk.length > MAX_HOOK_OUTPUT_BYTES - outputBytes) {
				stop("output limit exceeded")
				return
			}
			// Copy admitted bytes into owned, unpooled storage; a small view can own a much larger input buffer.
			const retained = Buffer.alloc(chunk.length)
			chunk.copy(retained)
			chunks.push(retained)
			outputBytes += retained.length
		}
		child.stdout!.on("data", (chunk: Buffer) => collect(stdoutChunks, chunk))
		child.stderr!.on("data", (chunk: Buffer) => collect(stderrChunks, chunk))
		child.on("error", () => {
			if (failure === undefined && !terminating) {
				failure = "could not start"
				finish(null)
			}
		})
		child.once("exit", () => (exited = true))
		child.on("close", (exitCode) => {
			exited = true
			resolveClosed()
			if (failure === undefined && !terminating) finish(exitCode)
		})
		child.stdin!.on("error", () => {
			// A command may close stdin before consuming the request.
		})
		if (signal.aborted) {
			cancel()
			return
		}
		child.stdin!.end(input)
	})
}

async function runHookCommands(
	commands: LifecycleHookHandler[],
	request: LifecycleHookRequest,
	signal: AbortSignal,
	options: CompletionHookRuntimeOptions,
): Promise<
	Array<
		| (Awaited<ReturnType<typeof runCommand>> & {
				runId: string
				completionOrder: number
				additionalContextLimit?: number
		  })
		| undefined
	>
> {
	// Configuration and direct callers share the same hard process limit.
	commands = commands.slice(0, MAX_HOOKS)
	const results: Array<
		| (Awaited<ReturnType<typeof runCommand>> & {
				runId: string
				completionOrder: number
				additionalContextLimit?: number
		  })
		| undefined
	> = new Array(commands.length)
	let nextIndex = 0
	let completionOrder = 0
	const failedCleanup = new AbortController()
	const commandSignal = AbortSignal.any([signal, failedCleanup.signal])
	const workers = await Promise.allSettled(
		Array.from({ length: Math.min(MAX_CONCURRENT_HOOKS, commands.length) }, async () => {
			while (!commandSignal.aborted && nextIndex < commands.length) {
				const index = nextIndex++
				const runId = crypto.randomUUID()
				try {
					const handler = commands[index]
					let result: HookCommandResult
					if (handler.type === "mcp_tool") {
						result = options.executeMcp
							? await options.executeMcp(handler, request, commandSignal)
							: {
									exitCode: null,
									stdout: "",
									stderr: "",
									failure: t("common:lifecycleHooks.mcpUnavailable"),
								}
					} else if (handler.async && request.hook_event_name !== "SessionEnd" && !options.advisory) {
						const captured = structuredClone(request)
						const config: CompletionHookConfig = { stop: [], subagentStop: [] }
						const key = (captured.hook_event_name[0].toLowerCase() +
							captured.hook_event_name.slice(1)) as keyof CompletionHookConfig
						config[key] = [{ ...handler, async: false }]
						const admitted = options.scheduleAsync?.(captured.hook_event_name, (asyncSignal) => {
							const advisory = { ...options, advisory: true }
							return isCompletionHookRequest(captured)
								? runCompletionHooks(config, captured, asyncSignal, advisory)
								: runLifecycleHooks(config, captured, asyncSignal, advisory)
						})
						result = {
							exitCode: admitted ? 0 : null,
							stdout: "",
							stderr: "",
							...(admitted ? {} : { failure: t("common:lifecycleHooks.asyncUnavailable") }),
						}
					} else {
						result = await runCommand(handler, request, commandSignal)
					}
					results[index] = {
						...result,
						runId,
						completionOrder: completionOrder++,
						additionalContextLimit: commands[index].additionalContextLimit,
					}
				} catch (error) {
					// Join sibling cleanup before returning an unconfirmed physical outcome.
					failedCleanup.abort(error)
					throw error
				}
			}
		}),
	)
	const errors = workers.flatMap((worker) => (worker.status === "rejected" ? [worker.reason] : []))
	if (errors.length === 1) throw errors[0]
	if (errors.length > 1) throw new AggregateError(errors, "Lifecycle hook process cleanup failed")
	return results
}

export async function runCompletionHooks(
	config: CompletionHookConfig,
	request: CompletionHookRequest,
	signal: AbortSignal,
	options: CompletionHookRuntimeOptions = {},
): Promise<CompletionHookOutcome> {
	const commands = selectLifecycleHookCommands(config, request)
	const results = await runHookCommands(commands, request, signal, options)
	const warnings: string[] = []
	const fragments: CompletionHookPromptFragment[] = []
	let stopReason: string | undefined
	let shouldStop = false
	for (const result of results) {
		if (!result) continue
		if (result.failure) {
			if (result.failure !== "cancelled") warnings.push(`Completion hook ${result.failure}.`)
			continue
		}
		let reason: string | undefined
		if (result.exitCode === 2 && !options.advisory) reason = result.stderr.trim()
		else if (result.exitCode === 0 && result.stdout.trim()) {
			try {
				const output: unknown = JSON.parse(result.stdout)
				if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("invalid output")
				const parsed = output as Record<string, unknown>
				if (
					Object.keys(parsed).some(
						(key) =>
							![
								"continue",
								"stopReason",
								"systemMessage",
								"suppressOutput",
								"decision",
								"reason",
							].includes(key),
					)
				)
					throw new Error("unknown output field")
				if (parsed.continue !== undefined && typeof parsed.continue !== "boolean")
					throw new Error("invalid continue")
				if (parsed.stopReason != null && typeof parsed.stopReason !== "string")
					throw new Error("invalid stopReason")
				if (parsed.systemMessage != null && typeof parsed.systemMessage !== "string")
					throw new Error("invalid systemMessage")
				if (parsed.suppressOutput !== undefined && typeof parsed.suppressOutput !== "boolean")
					throw new Error("invalid suppressOutput")
				if (parsed.reason != null && typeof parsed.reason !== "string") throw new Error("invalid reason")
				if (parsed.decision != null && parsed.decision !== "block") throw new Error("invalid decision")
				if (parsed.systemMessage) warnings.push(parsed.systemMessage)
				if (options.advisory) continue
				if (parsed.continue === false) {
					shouldStop = true
					stopReason ??= parsed.stopReason?.trim() || undefined
					continue
				}
				const decision = parsed.decision
				if (decision === "block") {
					const value = parsed.reason
					reason = typeof value === "string" ? value.trim() : ""
				}
			} catch {
				warnings.push("Completion hook returned invalid JSON output.")
			}
		} else if (result.exitCode !== 0) warnings.push("Completion hook failed.")
		if (reason !== undefined) {
			if (!reason) warnings.push("Completion hook requested continuation without a prompt; ignoring the block.")
			else fragments.push({ hook_run_id: result.runId, text: reason })
		}
	}
	if (shouldStop) return { shouldStop, ...(stopReason ? { stopReason } : {}), warnings }
	const boundedFragments: CompletionHookPromptFragment[] = []
	for (const fragment of fragments) {
		boundedFragments.push({ ...fragment, text: await preserveHookOutput(fragment.text) })
	}
	if (signal.aborted) return { warnings }
	const prompt = boundedFragments.map(({ text }) => text).join("\n\n")
	return { ...(prompt ? { prompt, fragments: boundedFragments } : {}), warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertKnownOutputKeys(value: Record<string, unknown>, keys: readonly string[]): void {
	if (Object.keys(value).some((key) => !keys.includes(key))) throw new Error("unknown output field")
}

/** Lifecycle hooks use the same bounded command executor as Stop hooks. They never grant tool authority. */
export async function runLifecycleHooks(
	config: CompletionHookConfig,
	request: Exclude<LifecycleHookRequest, CompletionHookRequest>,
	signal: AbortSignal,
	options: CompletionHookRuntimeOptions = {},
): Promise<LifecycleHookOutcome> {
	const event = request.hook_event_name
	const cleanupEvent = event === "SessionEnd" || event === "Interrupt"
	if (cleanupEvent) signal = AbortSignal.any([signal, AbortSignal.timeout(3_000)])
	const commands = selectLifecycleHookCommands(config, request).map((command) =>
		cleanupEvent ? { ...command, timeoutMs: Math.min(command.timeoutMs ?? 1_000, 3_000) } : command,
	)
	const results = await runHookCommands(commands, request, signal, options)
	const outcome: LifecycleHookOutcome = { warnings: [] }
	if (signal.aborted) return outcome
	const contexts: CompletionHookPromptFragment[] = []
	const feedback: string[] = []
	let latestRewrite = -1
	for (const result of results) {
		if (!result) continue
		if (result.failure) {
			if (result.failure !== "cancelled")
				outcome.warnings.push(t("common:lifecycleHooks.issue", { event, failure: result.failure }))
			continue
		}
		const stop = (reason: string | undefined) => {
			outcome.shouldStop = true
			outcome.stopReason ??= reason?.trim() || undefined
			outcome.stopProvenance ??= {
				event,
				fragments: [
					{
						hook_run_id: result.runId,
						text: reason?.trim() || t("common:lifecycleHooks.stopped", { event }),
					},
				],
			}
		}
		const block = (reason: string | undefined) => {
			if (!reason?.trim()) {
				outcome.warnings.push(t("common:lifecycleHooks.blockWithoutReason", { event }))
				return
			}
			if (event === "UserPromptSubmit") {
				stop(reason)
			} else if (event === "PreToolUse" || event === "PostToolUse" || event === "PermissionRequest") {
				outcome.shouldBlock = true
				outcome.blockReason ??= reason.trim()
				if (event === "PostToolUse") feedback.push(reason.trim())
			}
		}
		if (
			!options.advisory &&
			result.exitCode === 2 &&
			(event === "UserPromptSubmit" ||
				event === "PreToolUse" ||
				event === "PostToolUse" ||
				event === "PermissionRequest")
		) {
			block(result.stderr)
			continue
		}
		if (result.exitCode !== 0) {
			outcome.warnings.push(t("common:lifecycleHooks.failed", { event }))
			continue
		}
		if (event === "SessionEnd") continue
		const text = result.stdout.trim()
		if (!text) continue
		const contextEvent = event === "SessionStart" || event === "SubagentStart" || event === "UserPromptSubmit"
		if (contextEvent && !text.startsWith("{") && !text.startsWith("[")) {
			contexts.push({ hook_run_id: result.runId, text })
			continue
		}
		if (!text.startsWith("{") && !text.startsWith("[")) {
			if (event === "Interrupt") outcome.warnings.push(t("common:lifecycleHooks.invalidOutput", { event }))
			continue
		}
		try {
			const parsed: unknown = JSON.parse(text)
			if (!isRecord(parsed)) throw new Error("invalid output")
			// Mirror the supported event wire shapes (Codex 67f0994 schema.rs).
			// Unknown fields fail parsing even for advisory hooks; recognized but
			// unsupported control fields are ignored only by advisory execution.
			const outerKeys =
				event === "Interrupt"
					? ["systemMessage"]
					: ["continue", "stopReason", "systemMessage", "suppressOutput"]
			if (event === "PreToolUse" || event === "PostToolUse" || event === "UserPromptSubmit")
				outerKeys.push("decision", "reason")
			if (event !== "PreCompact" && event !== "PostCompact" && event !== "Interrupt")
				outerKeys.push("hookSpecificOutput")
			assertKnownOutputKeys(parsed, outerKeys)
			for (const key of ["continue", "suppressOutput"] as const) {
				if (parsed[key] !== undefined && typeof parsed[key] !== "boolean") throw new Error(`invalid ${key}`)
			}
			for (const key of ["stopReason", "systemMessage", "reason"] as const) {
				if (parsed[key] != null && typeof parsed[key] !== "string") throw new Error(`invalid ${key}`)
			}
			if (
				parsed.decision != null &&
				parsed.decision !== "block" &&
				!(event === "PreToolUse" && parsed.decision === "approve")
			)
				throw new Error("invalid decision")
			const specific = parsed.hookSpecificOutput
			if (
				specific != null &&
				(!isRecord(specific) ||
					specific.hookEventName !== event ||
					(specific.additionalContext != null && typeof specific.additionalContext !== "string"))
			)
				throw new Error("invalid hookSpecificOutput")
			const details = isRecord(specific) ? specific : {}
			const detailKeys = ["hookEventName"]
			if (event === "PermissionRequest") detailKeys.push("decision")
			else detailKeys.push("additionalContext")
			if (event === "PreToolUse")
				detailKeys.push("permissionDecision", "permissionDecisionReason", "updatedInput")
			if (event === "PostToolUse") detailKeys.push("updatedMCPToolOutput")
			assertKnownOutputKeys(details, detailKeys)
			if (event === "PreToolUse") {
				if (
					details.permissionDecision != null &&
					(typeof details.permissionDecision !== "string" ||
						!["allow", "deny", "ask"].includes(details.permissionDecision))
				)
					throw new Error("invalid permission decision")
				if (details.permissionDecisionReason != null && typeof details.permissionDecisionReason !== "string")
					throw new Error("invalid permission decision reason")
			}
			if (event === "PermissionRequest" && details.decision != null) {
				if (!isRecord(details.decision)) throw new Error("invalid permission decision")
				const decision = details.decision
				assertKnownOutputKeys(decision, [
					"behavior",
					"message",
					"updatedInput",
					"updatedPermissions",
					"interrupt",
				])
				if (decision.behavior !== "allow" && decision.behavior !== "deny")
					throw new Error("invalid permission behavior")
				if (decision.message != null && typeof decision.message !== "string")
					throw new Error("invalid permission message")
				if (decision.interrupt !== undefined && typeof decision.interrupt !== "boolean")
					throw new Error("invalid permission interrupt")
			}
			if (typeof parsed.systemMessage === "string" && parsed.systemMessage.trim()) {
				outcome.warnings.push(parsed.systemMessage)
			}
			if (event === "Interrupt") continue
			if (options.advisory) {
				if (typeof details.additionalContext === "string" && details.additionalContext.trim())
					contexts.push({ hook_run_id: result.runId, text: details.additionalContext.trim() })
				continue
			}
			let contextAllowed = !(
				(event === "PostToolUse" || event === "UserPromptSubmit") &&
				parsed.decision === "block" &&
				(typeof parsed.reason !== "string" || !parsed.reason.trim())
			)
			if (event === "PermissionRequest") {
				if (
					parsed.continue === false ||
					parsed.stopReason != null ||
					parsed.suppressOutput === true ||
					details.additionalContext != null
				) {
					throw new Error("unsupported permission output")
				}
				const decision = details.decision
				if (decision != null) {
					if (
						!isRecord(decision) ||
						decision.updatedInput != null ||
						decision.updatedPermissions != null ||
						decision.interrupt === true ||
						(decision.message != null && typeof decision.message !== "string")
					)
						throw new Error("unsupported permission decision")
					if (decision.behavior === "deny")
						block(
							typeof decision.message === "string" && decision.message.trim()
								? decision.message
								: t("common:lifecycleHooks.permissionDenied"),
						)
					else if (decision.behavior === "allow")
						outcome.warnings.push(t("common:lifecycleHooks.permissionAllowAdvisory"))
					else throw new Error("invalid permission decision")
				}
			} else if (event === "PreToolUse") {
				if (parsed.continue === false || parsed.stopReason != null || parsed.suppressOutput === true) {
					throw new Error("unsupported universal pre-tool output")
				}
				const decision = details.permissionDecision
				const usesSpecificDecision =
					decision != null || details.permissionDecisionReason != null || details.updatedInput != null
				if (usesSpecificDecision) {
					if (decision === "deny") {
						if (
							details.updatedInput != null ||
							typeof details.permissionDecisionReason !== "string" ||
							!details.permissionDecisionReason.trim()
						) {
							throw new Error("invalid denial")
						}
						block(details.permissionDecisionReason)
					} else if (decision === "allow" && isRecord(details.updatedInput)) {
						// This is an input rewrite, never an approval. The scheduler revalidates all arguments.
						if (result.completionOrder > latestRewrite) {
							latestRewrite = result.completionOrder
							outcome.updatedInput = structuredClone(details.updatedInput)
						}
					} else throw new Error("unsupported permission decision")
				} else if (parsed.decision === "block") {
					block(typeof parsed.reason === "string" ? parsed.reason : undefined)
				} else if (parsed.decision != null || parsed.reason != null) {
					throw new Error("unsupported legacy decision")
				}
			} else if (event === "PostToolUse") {
				const unsupported = parsed.suppressOutput === true || details.updatedMCPToolOutput != null
				const invalidBlock =
					parsed.decision === "block" && (typeof parsed.reason !== "string" || !parsed.reason.trim())
				contextAllowed = !unsupported && !invalidBlock
				if (parsed.continue === false) {
					const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : ""
					feedback.push(
						reason ||
							(typeof parsed.stopReason === "string"
								? parsed.stopReason
								: t("common:lifecycleHooks.postToolStopped")),
					)
				} else if (unsupported) {
					throw new Error("unsupported post-tool output")
				} else if (parsed.decision === "block") {
					block(typeof parsed.reason === "string" ? parsed.reason : undefined)
				} else if (parsed.decision != null || parsed.reason != null) {
					throw new Error("unsupported decision")
				}
			} else if (event !== "SubagentStart" && parsed.continue === false) {
				stop(typeof parsed.stopReason === "string" ? parsed.stopReason : undefined)
			} else if (event === "UserPromptSubmit") {
				if (parsed.decision === "block") {
					contextAllowed = typeof parsed.reason === "string" && Boolean(parsed.reason.trim())
					block(typeof parsed.reason === "string" ? parsed.reason : undefined)
				}
			}
			if (contextAllowed && typeof details.additionalContext === "string" && details.additionalContext.trim()) {
				contexts.push({ hook_run_id: result.runId, text: details.additionalContext.trim() })
			}
		} catch {
			outcome.warnings.push(t("common:lifecycleHooks.invalidOutput", { event }))
		}
	}
	if (outcome.shouldBlock) delete outcome.updatedInput
	if (feedback.length > 0) outcome.feedbackMessage = await preserveHookOutput(feedback.join("\n\n"))
	if (outcome.stopReason) outcome.stopReason = await preserveHookOutput(outcome.stopReason)
	if (outcome.blockReason) outcome.blockReason = await preserveHookOutput(outcome.blockReason)
	if (outcome.stopProvenance) {
		for (const fragment of outcome.stopProvenance.fragments) fragment.text = await preserveHookOutput(fragment.text)
	}
	const boundedContexts: CompletionHookPromptFragment[] = []
	for (const fragment of contexts) {
		const limit = results.find((result) => result?.runId === fragment.hook_run_id)?.additionalContextLimit
		boundedContexts.push({ ...fragment, text: await preserveHookOutput(fragment.text, limit) })
	}
	if (signal.aborted) return { warnings: [] }
	if (boundedContexts.length > 0) outcome.additionalContext = boundedContexts
	return outcome
}
