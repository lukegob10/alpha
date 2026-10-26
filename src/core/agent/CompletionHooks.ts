import { spawn } from "node:child_process"
import crypto from "node:crypto"
import * as path from "node:path"
import * as vscode from "vscode"
import { t } from "../../i18n"
import { terminateProcessTree } from "../../utils/processTree"
import type { LifecycleHookTarget } from "./LifecycleHookTargets"

export type { LifecycleHookTarget } from "./LifecycleHookTargets"

const MAX_HOOKS = 8
const MAX_CONCURRENT_HOOKS = 4
const MAX_OUTPUT_BYTES = 16_384
const MAX_PROMPT_CHARS = 4_000
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000
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

export interface CompletionHookCommand {
	command: string
	args?: string[]
	timeoutMs?: number
}

export interface CompletionHookConfig {
	stop: CompletionHookCommand[]
	subagentStop: CompletionHookCommand[]
	sessionStart?: CompletionHookCommand[]
	subagentStart?: CompletionHookCommand[]
	userPromptSubmit?: CompletionHookCommand[]
	preToolUse?: CompletionHookCommand[]
	postToolUse?: CompletionHookCommand[]
	permissionRequest?: CompletionHookCommand[]
	preCompact?: CompletionHookCommand[]
	postCompact?: CompletionHookCommand[]
	interrupt?: CompletionHookCommand[]
	sessionEnd?: CompletionHookCommand[]
}

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

function parseCommands(value: unknown): CompletionHookCommand[] {
	if (!Array.isArray(value)) return []
	return value.slice(0, MAX_HOOKS).flatMap((item): CompletionHookCommand[] => {
		if (!item || typeof item !== "object" || Array.isArray(item)) return []
		const candidate = item as Record<string, unknown>
		if (typeof candidate.command !== "string" || !path.isAbsolute(candidate.command)) return []
		if (
			candidate.args !== undefined &&
			(!Array.isArray(candidate.args) || !candidate.args.every((arg) => typeof arg === "string"))
		)
			return []
		if (
			candidate.timeoutMs !== undefined &&
			(typeof candidate.timeoutMs !== "number" ||
				!Number.isInteger(candidate.timeoutMs) ||
				candidate.timeoutMs < 100 ||
				candidate.timeoutMs > MAX_TIMEOUT_MS)
		)
			return []
		return [
			{
				command: candidate.command,
				args: candidate.args === undefined ? undefined : [...(candidate.args as string[])],
				timeoutMs: candidate.timeoutMs as number | undefined,
			},
		]
	})
}

/** Machine-scoped VS Code settings are explicitly user-owned; workspace content cannot install executable hooks. */
export function readCompletionHookConfig(): CompletionHookConfig {
	const inspected = vscode.workspace.getConfiguration("alpha").inspect?.<unknown>("completionHooks")
	const raw = inspected?.globalValue ?? inspected?.defaultValue
	const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
	const config: CompletionHookConfig = {
		stop: parseCommands(value.stop),
		subagentStop: parseCommands(value.subagentStop),
	}
	for (const key of [
		"sessionStart",
		"subagentStart",
		"userPromptSubmit",
		"preToolUse",
		"postToolUse",
		"permissionRequest",
		"preCompact",
		"postCompact",
		"interrupt",
		"sessionEnd",
	] as const) {
		if (value[key] !== undefined) config[key] = parseCommands(value[key])
	}
	return config
}

async function runCommand(
	hook: CompletionHookCommand,
	request: LifecycleHookRequest,
	signal: AbortSignal,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; failure?: string }> {
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
		}, hook.timeoutMs ?? DEFAULT_TIMEOUT_MS)
		signal.addEventListener("abort", cancel, { once: true })
		const collect = (chunks: Buffer[], chunk: Buffer) => {
			// Latch failure before termination: Windows taskkill may still be pending or starting.
			if (settled || failure !== undefined || terminating || chunk.length === 0) return
			if (chunk.length > MAX_OUTPUT_BYTES - outputBytes) {
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
	commands: CompletionHookCommand[],
	request: LifecycleHookRequest,
	signal: AbortSignal,
): Promise<Array<(Awaited<ReturnType<typeof runCommand>> & { runId: string; completionOrder: number }) | undefined>> {
	// Configuration and direct callers share the same hard process limit.
	commands = commands.slice(0, MAX_HOOKS)
	const results: Array<
		(Awaited<ReturnType<typeof runCommand>> & { runId: string; completionOrder: number }) | undefined
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
					const result = await runCommand(commands[index], request, commandSignal)
					results[index] = { ...result, runId, completionOrder: completionOrder++ }
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
): Promise<CompletionHookOutcome> {
	const commands = request.hook_event_name === "Stop" ? config.stop : config.subagentStop
	const results = await runHookCommands(commands, request, signal)
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
		if (result.exitCode === 2) reason = result.stderr.trim()
		else if (result.exitCode === 0 && result.stdout.trim()) {
			try {
				const output: unknown = JSON.parse(result.stdout)
				if (!output || typeof output !== "object" || Array.isArray(output)) throw new Error("invalid output")
				const parsed = output as Record<string, unknown>
				if (parsed.continue !== undefined && typeof parsed.continue !== "boolean")
					throw new Error("invalid continue")
				if (parsed.stopReason !== undefined && typeof parsed.stopReason !== "string")
					throw new Error("invalid stopReason")
				if (parsed.systemMessage !== undefined && typeof parsed.systemMessage !== "string")
					throw new Error("invalid systemMessage")
				if (parsed.suppressOutput !== undefined && typeof parsed.suppressOutput !== "boolean")
					throw new Error("invalid suppressOutput")
				if (parsed.systemMessage) warnings.push(parsed.systemMessage)
				if (parsed.continue === false) {
					shouldStop = true
					stopReason ??= parsed.stopReason?.trim() || undefined
					continue
				}
				const decision = parsed.decision
				if (decision === "block") {
					const value = parsed.reason
					reason = typeof value === "string" ? value.trim() : ""
				} else if (decision !== undefined && decision !== "allow") throw new Error("invalid decision")
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
	let remaining = MAX_PROMPT_CHARS
	const boundedFragments = fragments.flatMap(({ hook_run_id, text }) => {
		if (remaining <= 0) return []
		const bounded = text.slice(0, remaining)
		remaining -= bounded.length + 2
		return [{ hook_run_id, text: bounded }]
	})
	const prompt = boundedFragments.map(({ text }) => text).join("\n\n")
	return { ...(prompt ? { prompt, fragments: boundedFragments } : {}), warnings }
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

/** Lifecycle hooks use the same bounded command executor as Stop hooks. They never grant tool authority. */
export async function runLifecycleHooks(
	config: CompletionHookConfig,
	request: Exclude<LifecycleHookRequest, CompletionHookRequest>,
	signal: AbortSignal,
): Promise<LifecycleHookOutcome> {
	const configKeys = {
		SessionStart: "sessionStart",
		SubagentStart: "subagentStart",
		UserPromptSubmit: "userPromptSubmit",
		PreToolUse: "preToolUse",
		PostToolUse: "postToolUse",
		PermissionRequest: "permissionRequest",
		PreCompact: "preCompact",
		PostCompact: "postCompact",
		Interrupt: "interrupt",
		SessionEnd: "sessionEnd",
	} as const
	const event = request.hook_event_name
	const cleanupEvent = event === "SessionEnd" || event === "Interrupt"
	if (cleanupEvent) signal = AbortSignal.any([signal, AbortSignal.timeout(3_000)])
	const commands = (config[configKeys[event]] ?? []).map((command) =>
		cleanupEvent ? { ...command, timeoutMs: Math.min(command.timeoutMs ?? 1_000, 3_000) } : command,
	)
	const results = await runHookCommands(commands, request, signal)
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
			outcome.stopReason ??= reason?.trim().slice(0, MAX_PROMPT_CHARS) || undefined
			outcome.stopProvenance ??= {
				event,
				fragments: [
					{
						hook_run_id: result.runId,
						text:
							reason?.trim().slice(0, MAX_PROMPT_CHARS) || t("common:lifecycleHooks.stopped", { event }),
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
				outcome.blockReason ??= reason.trim().slice(0, MAX_PROMPT_CHARS)
				if (event === "PostToolUse") feedback.push(reason.trim())
			}
		}
		if (
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
			for (const key of ["continue", "suppressOutput"] as const) {
				if (parsed[key] !== undefined && typeof parsed[key] !== "boolean") throw new Error(`invalid ${key}`)
			}
			for (const key of ["stopReason", "systemMessage", "reason"] as const) {
				if (parsed[key] !== undefined && typeof parsed[key] !== "string") throw new Error(`invalid ${key}`)
			}
			const specific = parsed.hookSpecificOutput
			if (
				specific !== undefined &&
				(!isRecord(specific) ||
					specific.hookEventName !== event ||
					(specific.additionalContext !== undefined && typeof specific.additionalContext !== "string"))
			)
				throw new Error("invalid hookSpecificOutput")
			const details = isRecord(specific) ? specific : {}
			if ((event === "PreCompact" || event === "PostCompact") && specific !== undefined) {
				throw new Error("unsupported stateless compact output")
			}
			if (typeof parsed.systemMessage === "string" && parsed.systemMessage.trim()) {
				outcome.warnings.push(parsed.systemMessage.slice(0, MAX_PROMPT_CHARS))
			}
			if (event === "Interrupt") continue
			if (event === "PermissionRequest") {
				if (
					parsed.continue === false ||
					parsed.stopReason !== undefined ||
					parsed.suppressOutput === true ||
					details.additionalContext !== undefined
				) {
					throw new Error("unsupported permission output")
				}
				const decision = details.decision
				if (decision !== undefined) {
					if (
						!isRecord(decision) ||
						decision.updatedInput !== undefined ||
						decision.updatedPermissions !== undefined ||
						decision.interrupt === true ||
						(decision.message !== undefined && typeof decision.message !== "string")
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
				if (parsed.continue === false || parsed.stopReason !== undefined || parsed.suppressOutput === true) {
					throw new Error("unsupported universal pre-tool output")
				}
				const decision = details.permissionDecision
				const usesSpecificDecision =
					decision !== undefined ||
					details.permissionDecisionReason !== undefined ||
					details.updatedInput !== undefined
				if (usesSpecificDecision) {
					if (decision === "deny") {
						if (
							details.updatedInput !== undefined ||
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
				} else if (parsed.decision !== undefined || parsed.reason !== undefined) {
					throw new Error("unsupported legacy decision")
				}
			} else if (event === "PostToolUse") {
				if (parsed.suppressOutput === true || details.updatedMCPToolOutput !== undefined) {
					throw new Error("unsupported post-tool output")
				}
				if (parsed.continue === false) {
					const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : ""
					feedback.push(
						reason ||
							(typeof parsed.stopReason === "string"
								? parsed.stopReason
								: t("common:lifecycleHooks.postToolStopped")),
					)
				} else if (parsed.decision === "block") {
					block(typeof parsed.reason === "string" ? parsed.reason : undefined)
				} else if (parsed.decision !== undefined || parsed.reason !== undefined) {
					throw new Error("unsupported decision")
				}
			} else if (event !== "SubagentStart" && parsed.continue === false) {
				stop(typeof parsed.stopReason === "string" ? parsed.stopReason : undefined)
			} else if (event === "UserPromptSubmit") {
				if (parsed.decision === "block") block(typeof parsed.reason === "string" ? parsed.reason : undefined)
				else if (parsed.decision !== undefined || parsed.reason !== undefined)
					throw new Error("unsupported decision")
			}
			if (typeof details.additionalContext === "string" && details.additionalContext.trim()) {
				contexts.push({ hook_run_id: result.runId, text: details.additionalContext.trim() })
			}
		} catch {
			outcome.warnings.push(t("common:lifecycleHooks.invalidOutput", { event }))
		}
	}
	if (outcome.shouldBlock) delete outcome.updatedInput
	if (feedback.length > 0) outcome.feedbackMessage = feedback.join("\n\n").slice(0, MAX_PROMPT_CHARS)
	let remaining = MAX_PROMPT_CHARS
	const boundedContexts = contexts.flatMap((fragment) => {
		if (remaining <= 0) return []
		const text = fragment.text.slice(0, remaining)
		remaining -= text.length + 2
		return [{ ...fragment, text }]
	})
	if (boundedContexts.length > 0) outcome.additionalContext = boundedContexts
	return outcome
}
