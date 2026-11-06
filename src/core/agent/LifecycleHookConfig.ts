import * as path from "node:path"
import * as vscode from "vscode"
import { t } from "../../i18n"
import type { LifecycleHookTarget } from "./LifecycleHookTargets"

export const DEFAULT_HOOK_TIMEOUT_MS = 600_000
export const MAX_HOOK_TIMEOUT_MS = 2_147_483_647
// Four supported configuration spellings can each contain eight groups of eight handlers.
export const MAX_LIFECYCLE_HOOK_HANDLERS = 256

export function assertLifecycleHookHandlerLimit(event: LifecycleHookTarget, count: number): void {
	if (count > MAX_LIFECYCLE_HOOK_HANDLERS) {
		throw new RangeError(t("common:lifecycleHooks.handlerLimit", { event, limit: MAX_LIFECYCLE_HOOK_HANDLERS }))
	}
}

export interface CompletionHookCommand {
	command: string
	args?: string[]
	timeoutMs?: number
	type?: "command"
	matcher?: string
	async?: boolean
	additionalContextLimit?: number
}

export interface CompletionHookMcp {
	type: "mcp_tool"
	server: string
	tool: string
	input?: Record<string, unknown>
	timeoutMs?: number
	matcher?: string
	additionalContextLimit?: number
}

export type LifecycleHookHandler = CompletionHookCommand | CompletionHookMcp

const configKeys = {
	Stop: "stop",
	SubagentStop: "subagentStop",
	SessionStart: "sessionStart",
	SubagentStart: "subagentStart",
	UserPromptSubmit: "userPromptSubmit",
	PreToolUse: "preToolUse",
	PostToolUse: "postToolUse",
	PermissionRequest: "permissionRequest",
	PreModelRequest: "preModelRequest",
	PostModelRequest: "postModelRequest",
	PreCompact: "preCompact",
	PostCompact: "postCompact",
	Interrupt: "interrupt",
	SessionEnd: "sessionEnd",
} as const satisfies Record<LifecycleHookTarget, string>

type ConfigKey = (typeof configKeys)[LifecycleHookTarget]
export type CompletionHookConfig = {
	stop: LifecycleHookHandler[]
	subagentStop: LifecycleHookHandler[]
} & Partial<Record<Exclude<ConfigKey, "stop" | "subagentStop">, LifecycleHookHandler[]>>

interface HookMatchRequest {
	hook_event_name: LifecycleHookTarget
	tool_name?: string
	source?: string
	trigger?: string
	agent_type?: string
	reason?: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validMatcher(value: unknown): value is string | undefined {
	if (value === undefined) return true
	if (typeof value !== "string" || value.length > 4_096) return false
	if (!value || value === "*" || /^[A-Za-z0-9_|]+$/.test(value)) return true
	try {
		new RegExp(value)
		return true
	} catch {
		return false
	}
}

function parseHandler(value: unknown, event: LifecycleHookTarget, matcher?: string): LifecycleHookHandler | undefined {
	if (!isRecord(value) || !validMatcher(value.matcher)) return undefined
	const effectiveMatcher = matcher ?? value.matcher
	const timeoutMs = value.timeoutMs ?? (typeof value.timeout === "number" ? value.timeout * 1_000 : undefined)
	if (
		(value.timeout !== undefined && (typeof value.timeout !== "number" || !Number.isInteger(value.timeout))) ||
		(timeoutMs !== undefined &&
			(typeof timeoutMs !== "number" ||
				!Number.isInteger(timeoutMs) ||
				timeoutMs <= 0 ||
				timeoutMs > MAX_HOOK_TIMEOUT_MS)) ||
		(value.additionalContextLimit !== undefined &&
			(typeof value.additionalContextLimit !== "number" ||
				!Number.isSafeInteger(value.additionalContextLimit) ||
				value.additionalContextLimit < 0))
	)
		return undefined
	const common = {
		...(timeoutMs === undefined ? {} : { timeoutMs }),
		...(effectiveMatcher === undefined ? {} : { matcher: effectiveMatcher }),
		...(value.additionalContextLimit === undefined ? {} : { additionalContextLimit: value.additionalContextLimit }),
	}
	if (value.type === "mcp_tool") {
		if (
			event === "SessionEnd" ||
			typeof value.server !== "string" ||
			!value.server.trim() ||
			typeof value.tool !== "string" ||
			!value.tool.trim() ||
			(value.input !== undefined && !isRecord(value.input)) ||
			value.async !== undefined
		)
			return undefined
		return {
			type: "mcp_tool",
			server: value.server,
			tool: value.tool,
			...(value.input === undefined ? {} : { input: structuredClone(value.input) }),
			...common,
		}
	}
	if (value.type !== undefined && value.type !== "command") return undefined
	const command =
		process.platform === "win32" && value.commandWindows !== undefined ? value.commandWindows : value.command
	if (
		typeof command !== "string" ||
		!path.isAbsolute(command) ||
		(value.commandWindows !== undefined && typeof value.commandWindows !== "string") ||
		(value.args !== undefined &&
			(!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === "string"))) ||
		(value.async !== undefined && typeof value.async !== "boolean")
	)
		return undefined
	return {
		command,
		...(value.type === undefined ? {} : { type: value.type }),
		...(value.args === undefined ? {} : { args: [...value.args] }),
		...(event === "SessionEnd" || value.async === undefined ? {} : { async: value.async }),
		...common,
	}
}

/** Native adapters retain user-owned no-shell execution; workspace configuration cannot install hooks. */
export function parseLifecycleHookConfig(raw: unknown): CompletionHookConfig {
	const value = isRecord(raw) ? raw : {}
	const nested = isRecord(value.hooks) ? value.hooks : {}
	const config: CompletionHookConfig = { stop: [], subagentStop: [] }
	for (const event of Object.keys(configKeys) as LifecycleHookTarget[]) {
		const key = configKeys[event]
		const sources = [value[key], value[event], nested[key], nested[event]].filter(Array.isArray)
		if (!sources.length) continue
		const handlers: LifecycleHookHandler[] = []
		for (const source of sources) {
			for (const item of source) {
				const group = isRecord(item) && Array.isArray(item.hooks) ? item : undefined
				if (group && !validMatcher(group.matcher)) continue
				for (const candidate of group ? (group.hooks as unknown[]) : [item]) {
					const handler = parseHandler(candidate, event, group?.matcher as string | undefined)
					if (handler) {
						assertLifecycleHookHandlerLimit(event, handlers.length + 1)
						handlers.push(handler)
					}
				}
			}
		}
		config[key] = handlers
	}
	return config
}

export function readCompletionHookConfig(): CompletionHookConfig {
	const inspected = vscode.workspace.getConfiguration("alpha").inspect?.<unknown>("completionHooks")
	return parseLifecycleHookConfig(inspected?.globalValue ?? inspected?.defaultValue)
}

function matcherInputs(request: HookMatchRequest): string[] | undefined {
	switch (request.hook_event_name) {
		case "Stop":
		case "UserPromptSubmit":
		case "Interrupt":
		case "PreModelRequest":
		case "PostModelRequest":
			return undefined
		case "SessionStart":
			return [request.source ?? ""]
		case "PreCompact":
		case "PostCompact":
			return [request.trigger ?? ""]
		case "SubagentStart":
		case "SubagentStop":
			return [request.agent_type ?? ""]
		case "SessionEnd":
			return [request.reason ?? ""]
		default: {
			const name = request.tool_name ?? ""
			if (name === "spawn_agent" || name === "Agent") return [name, "Agent"]
			if (["Bash", "exec_command", "execute_command", "shell", "shell_command"].includes(name))
				return [name, "Bash"]
			if (["apply_patch", "apply_diff", "edit", "edit_file", "write_to_file"].includes(name))
				return [name, "apply_patch", "Edit", "Write"]
			return [name]
		}
	}
}

/** Match Codex 67f0994 event fields and exact-name alternatives using native TypeScript regexes. */
export function selectLifecycleHookCommands(
	config: CompletionHookConfig,
	request: HookMatchRequest,
): LifecycleHookHandler[] {
	const inputs = matcherInputs(request)
	return (config[configKeys[request.hook_event_name]] ?? []).filter(({ matcher }) => {
		if (inputs === undefined || matcher === undefined || matcher === "" || matcher === "*") return true
		if (!validMatcher(matcher)) return false
		if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split("|").some((name) => inputs.includes(name))
		const pattern = new RegExp(matcher)
		return inputs.some((input) => pattern.test(input))
	})
}
