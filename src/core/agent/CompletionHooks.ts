import { spawn } from "node:child_process"
import crypto from "node:crypto"
import * as path from "node:path"
import * as vscode from "vscode"

const MAX_HOOKS = 8
const MAX_CONCURRENT_HOOKS = 4
const MAX_OUTPUT_BYTES = 16_384
const MAX_PROMPT_CHARS = 4_000
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_TIMEOUT_MS = 30_000

export type CompletionHookTarget = "Stop" | "SubagentStop"

export interface CompletionHookCommand {
	command: string
	args?: string[]
	timeoutMs?: number
}

export interface CompletionHookConfig {
	stop: CompletionHookCommand[]
	subagentStop: CompletionHookCommand[]
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
	event: CompletionHookTarget
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
				args: candidate.args as string[] | undefined,
				timeoutMs: candidate.timeoutMs as number | undefined,
			},
		]
	})
}

/** Machine-scoped VS Code settings are explicitly user-owned; workspace content cannot install executable hooks. */
export function readCompletionHookConfig(): CompletionHookConfig {
	const raw = vscode.workspace.getConfiguration("alpha").get<unknown>("completionHooks")
	const value = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {}
	return { stop: parseCommands(value.stop), subagentStop: parseCommands(value.subagentStop) }
}

async function runCommand(
	hook: CompletionHookCommand,
	request: CompletionHookRequest,
	signal: AbortSignal,
): Promise<{ exitCode: number | null; stdout: string; stderr: string; failure?: string }> {
	if (signal.aborted) return { exitCode: null, stdout: "", stderr: "", failure: "cancelled" }
	return new Promise((resolve) => {
		let settled = false
		let stdout = ""
		let stderr = ""
		let failure: string | undefined
		let terminating: Promise<void> | undefined
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
			resolve({ exitCode: null, stdout, stderr, failure: "could not start" })
			return
		}
		const finish = (exitCode: number | null) => {
			if (settled) return
			settled = true
			clearTimeout(timeout)
			signal.removeEventListener("abort", cancel)
			resolve({ exitCode, stdout, stderr, failure })
		}
		const stop = (reason: string) => {
			if (settled || terminating) return
			failure = reason
			terminating = terminateProcessTree(child)
			void terminating.finally(() => finish(null))
		}
		const cancel = () => stop("cancelled")
		const timeout = setTimeout(() => {
			stop("timed out")
		}, hook.timeoutMs ?? DEFAULT_TIMEOUT_MS)
		signal.addEventListener("abort", cancel, { once: true })
		child.stdout!.on("data", (chunk: Buffer) => {
			if (settled) return
			stdout += chunk.toString("utf8")
			if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
				stop("output limit exceeded")
			}
		})
		child.stderr!.on("data", (chunk: Buffer) => {
			if (settled) return
			stderr += chunk.toString("utf8")
			if (Buffer.byteLength(stderr) > MAX_OUTPUT_BYTES) {
				stop("output limit exceeded")
			}
		})
		child.on("error", () => {
			if (!terminating) {
				failure = "could not start"
				finish(null)
			}
		})
		child.on("close", (exitCode) => {
			if (!terminating) finish(exitCode)
		})
		child.stdin!.on("error", () => {
			// A command may close stdin before consuming the request.
		})
		if (signal.aborted) {
			cancel()
			return
		}
		child.stdin!.end(JSON.stringify(request))
	})
}

/** Detached POSIX process groups and Windows taskkill include descendants of a hook. */
async function terminateProcessTree(child: ReturnType<typeof spawn>): Promise<void> {
	if (!child.pid) return
	if (process.platform !== "win32") {
		try {
			process.kill(-child.pid, "SIGKILL")
			return
		} catch {
			child.kill("SIGKILL")
			return
		}
	}
	await new Promise<void>((resolve) => {
		let killer: ReturnType<typeof spawn>
		try {
			const systemRoot = process.env.SystemRoot ?? process.env.windir
			if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error("Windows system root unavailable")
			killer = spawn(path.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
				stdio: "ignore",
				windowsHide: true,
				shell: false,
			})
		} catch {
			child.kill("SIGKILL")
			resolve()
			return
		}
		const timer = setTimeout(() => {
			killer.kill("SIGKILL")
			child.kill("SIGKILL")
			resolve()
		}, 2_000)
		const done = () => {
			clearTimeout(timer)
			child.kill("SIGKILL")
			resolve()
		}
		killer.once("error", done)
		killer.once("close", done)
	})
}

export async function runCompletionHooks(
	config: CompletionHookConfig,
	request: CompletionHookRequest,
	signal: AbortSignal,
): Promise<CompletionHookOutcome> {
	const commands = request.hook_event_name === "Stop" ? config.stop : config.subagentStop
	const results: Array<(Awaited<ReturnType<typeof runCommand>> & { runId: string }) | undefined> = new Array(
		commands.length,
	)
	let nextIndex = 0
	await Promise.all(
		Array.from({ length: Math.min(MAX_CONCURRENT_HOOKS, commands.length) }, async () => {
			while (!signal.aborted && nextIndex < commands.length) {
				const index = nextIndex++
				const runId = crypto.randomUUID()
				results[index] = { ...(await runCommand(commands[index], request, signal)), runId }
			}
		}),
	)
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
