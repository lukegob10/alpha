import type { McpToolCallResponse } from "@alpha-code/types"
import { t } from "../../i18n"
import type { McpHub } from "../../services/mcp/McpHub"
import type { McpElicitationOwner } from "../../services/mcp/elicitation"
import { DEFAULT_HOOK_TIMEOUT_MS, MAX_HOOK_TIMEOUT_MS, type CompletionHookMcp } from "./LifecycleHookConfig"
import { MAX_HOOK_OUTPUT_BYTES } from "./HookOutput"
import type { LifecycleHookRequest } from "./CompletionHooks"

export type LifecycleHookMcpHub = Pick<McpHub, "getServers" | "callTool"> & Partial<Pick<McpHub, "withElicitation">>

export interface LifecycleHookMcpOptions {
	hub?: LifecycleHookMcpHub
	elicitationOwner?: McpElicitationOwner
}

export interface LifecycleHookMcpResult {
	exitCode: number | null
	stdout: string
	stderr: string
	failure?: string
}

/** Codex 67f0994 hook templates preserve JSON values for whole placeholders and stringify embedded values. */
export function expandHookMcpInput(template: Record<string, unknown>, event: unknown): Record<string, unknown> {
	let nodes = 0
	const lookup = (key: string): unknown => {
		let value = event
		for (const field of key.split(".")) {
			if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, field)) {
				throw new Error("Hook input placeholder was not found")
			}
			value = (value as Record<string, unknown>)[field]
		}
		if (value === undefined) throw new Error("Hook input placeholder was not found")
		return structuredClone(value)
	}
	const resolve = (value: unknown, depth: number): unknown => {
		if (++nodes > 10_000 || depth > 64) throw new Error("Hook input template exceeds its bound")
		if (typeof value === "string") {
			const exact = /^\$\{([^{}]+)\}$/.exec(value)
			if (exact) return lookup(exact[1])
			return value.replace(/\$\{([^{}]+)\}/g, (_match, key: string) => {
				const replacement = lookup(key)
				return typeof replacement === "string" ? replacement : JSON.stringify(replacement)
			})
		}
		if (Array.isArray(value)) return value.map((item) => resolve(item, depth + 1))
		if (value && typeof value === "object") {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolve(item, depth + 1)]))
		}
		if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))
			return value
		throw new Error("Hook input template must contain JSON values")
	}
	return Object.fromEntries(Object.entries(template).map(([key, value]) => [key, resolve(value, 0)]))
}

function awaitHookMcpResult(dispatch: () => Promise<McpToolCallResponse>, signal: AbortSignal) {
	return new Promise<McpToolCallResponse>((resolve, reject) => {
		const cancel = () => {
			signal.removeEventListener("abort", cancel)
			reject(signal.reason)
		}
		signal.addEventListener("abort", cancel, { once: true })
		if (signal.aborted) {
			cancel()
			return
		}
		try {
			void dispatch()
				.then(resolve, reject)
				.finally(() => signal.removeEventListener("abort", cancel))
		} catch (error) {
			signal.removeEventListener("abort", cancel)
			reject(error)
		}
	})
}

function serverTimeoutMs(config: string): number {
	try {
		const timeout: unknown = JSON.parse(config)?.timeout
		if (typeof timeout === "number" && Number.isFinite(timeout) && timeout >= 1 && timeout <= 3_600)
			return timeout * 1_000
	} catch {
		// Match the existing MCP server's fallback without importing its runtime.
	}
	return 60_000
}

/** Uses an existing connection directly; hook calls never re-enter tool scheduling or request model approval. */
export async function runLifecycleHookMcp(
	hook: CompletionHookMcp,
	event: LifecycleHookRequest,
	signal: AbortSignal,
	options: LifecycleHookMcpOptions = {},
): Promise<LifecycleHookMcpResult> {
	const failure = (message: string): LifecycleHookMcpResult => ({
		exitCode: null,
		stdout: "",
		stderr: "",
		failure: message,
	})
	if (signal.aborted) return failure("cancelled")
	if (event.hook_event_name === "SessionEnd") return failure(t("common:lifecycleHooks.mcpSessionEnd"))
	const hub = options.hub
	const server = hub?.getServers().find((item) => item.name === hook.server)
	if (
		!hub ||
		!server ||
		server.disabled ||
		server.status !== "connected" ||
		!server.tools?.some((tool) => tool.name === hook.tool && tool.enabledForPrompt !== false)
	)
		return failure(t("common:lifecycleHooks.mcpToolUnavailable"))
	let input: Record<string, unknown>
	try {
		input = expandHookMcpInput(hook.input ?? {}, event)
	} catch {
		return failure(t("common:lifecycleHooks.mcpInputInvalid"))
	}
	const deadline = new AbortController()
	const executionSignal = AbortSignal.any([signal, deadline.signal])
	let remaining = Math.min(hook.timeoutMs ?? DEFAULT_HOOK_TIMEOUT_MS, serverTimeoutMs(server.config))
	let activeStarted = Date.now()
	let timer: ReturnType<typeof setTimeout> | undefined
	let finished = false
	const resume = () => {
		if (finished || executionSignal.aborted) return
		activeStarted = Date.now()
		timer = setTimeout(() => deadline.abort(), remaining)
	}
	const pause = () => {
		if (timer === undefined) return
		clearTimeout(timer)
		timer = undefined
		remaining = Math.max(0, remaining - (Date.now() - activeStarted))
		if (remaining === 0) deadline.abort()
	}
	resume()
	try {
		const dispatch = () =>
			hub.callTool(hook.server, hook.tool, input, server.source, executionSignal, {
				transportTimeoutMs: MAX_HOOK_TIMEOUT_MS,
			})
		const owner = options.elicitationOwner
		const response = await awaitHookMcpResult(
			() =>
				owner && hub.withElicitation
					? hub.withElicitation(
							hook.server,
							server.source,
							{
								signal: executionSignal,
								ask: async (message, schema, questionSignal) => {
									pause()
									executionSignal.throwIfAborted()
									try {
										return await owner.ask(message, schema, questionSignal)
									} finally {
										resume()
									}
								},
							},
							dispatch,
						)
					: dispatch(),
			executionSignal,
		)
		if (executionSignal.aborted) return failure(signal.aborted ? "cancelled" : "timed out")
		if (response.isError) return failure(t("common:lifecycleHooks.mcpToolError"))
		// Upstream consumes text blocks only; structuredContent and media do not carry hook decisions.
		const texts: string[] = []
		let bytes = 0
		for (const content of response.content) {
			if (content.type !== "text") continue
			bytes += Buffer.byteLength(content.text) + (texts.length ? 1 : 0)
			if (bytes > MAX_HOOK_OUTPUT_BYTES) return failure("output limit exceeded")
			texts.push(content.text)
		}
		return { exitCode: 0, stdout: texts.join("\n"), stderr: "" }
	} catch {
		return failure(
			signal.aborted
				? "cancelled"
				: deadline.signal.aborted
					? "timed out"
					: t("common:lifecycleHooks.mcpCallFailed"),
		)
	} finally {
		finished = true
		clearTimeout(timer)
	}
}
