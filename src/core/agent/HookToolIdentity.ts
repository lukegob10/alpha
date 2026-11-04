import type { AgentToolCall } from "./AgentResponse"
import { TOOL_ALIASES } from "../../shared/tools"
import { parseMcpToolName } from "../../utils/mcp-name"

type HookCall = Pick<AgentToolCall, "name" | "arguments">

export interface HookToolIdentity {
	name: string
	matcherAliases: readonly string[]
	input: Record<string, unknown>
}

function argumentsFor(call: HookCall): Record<string, unknown> {
	return call.arguments && typeof call.arguments === "object" && !Array.isArray(call.arguments)
		? structuredClone(call.arguments as Record<string, unknown>)
		: {}
}

/** Codex 67f0994: hook compatibility names belong at the adapter, outside policy and executable tool identity. */
export function getHookToolIdentity(call: HookCall): HookToolIdentity {
	const name = TOOL_ALIASES[call.name] ?? call.name
	const input = argumentsFor(call)
	if (name === "exec_command") {
		return { name: "Bash", matcherAliases: [], input: { command: input.cmd ?? input.command } }
	}
	if (name === "apply_patch") {
		return { name, matcherAliases: ["Write", "Edit"], input: { command: input.patch } }
	}
	const mcp = parseMcpToolName(name)
	return {
		name: mcp ? `mcp__${mcp.serverName}__${mcp.toolName}` : name,
		matcherAliases: name === "spawn_agent" ? ["Agent"] : [],
		input,
	}
}

/** A hook can replace command text, while native execution and approval settings retain their captured authority. */
export function applyHookToolInput(call: HookCall, updatedInput: Record<string, unknown>): Record<string, unknown> {
	const name = TOOL_ALIASES[call.name] ?? call.name
	if (name === "exec_command" || name === "apply_patch") {
		if (typeof updatedInput.command !== "string") throw new Error(`${name} hook updatedInput requires command`)
		const original = argumentsFor(call)
		const key = name === "apply_patch" ? "patch" : typeof original.cmd === "string" ? "cmd" : "command"
		const rewritten = { ...original, [key]: updatedInput.command }
		// Prepared calls can contain both aliases; scheduler revalidation must see one command.
		if (key === "cmd" && typeof original.command === "string") rewritten.command = updatedInput.command
		return rewritten
	}
	return structuredClone(updatedInput)
}
