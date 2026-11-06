import * as vscode from "vscode"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import i18next from "i18next"
import common from "../../../i18n/locales/en/common.json"
import { parseLifecycleHookConfig, readCompletionHookConfig, selectLifecycleHookCommands } from "../LifecycleHookConfig"

const command = { command: process.execPath, args: ["hook.js"] }

beforeAll(() => i18next.addResourceBundle("en", "common", common, true, true))

afterEach(() => vi.restoreAllMocks())

describe("lifecycle hook configuration", () => {
	it("recognizes model-request observers in native and Codex naming without match filters", () => {
		const config = parseLifecycleHookConfig({
			PreModelRequest: [{ ...command, matcher: "never" }],
			postModelRequest: [{ ...command, async: true }],
		})
		expect(config.preModelRequest).toEqual([{ ...command, matcher: "never" }])
		expect(config.postModelRequest).toEqual([{ ...command, async: true }])
		expect(selectLifecycleHookCommands(config, { hook_event_name: "PreModelRequest" })).toEqual(
			config.preModelRequest,
		)
	})

	it("preserves legacy command arrays and merges event groups in declaration order", () => {
		const config = parseLifecycleHookConfig({
			stop: [command],
			Stop: [{ hooks: [{ ...command, args: ["second.js"], timeout: 600 }] }],
			hooks: { Stop: [{ hooks: [{ ...command, args: ["third.js"] }] }] },
		})
		expect(config).toEqual({
			stop: [
				command,
				{ ...command, args: ["second.js"], timeoutMs: 600_000 },
				{ ...command, args: ["third.js"] },
			],
			subagentStop: [],
		})
	})

	it("keeps user-owned configuration authoritative over workspace executables", () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
			inspect: () => ({
				defaultValue: {},
				workspaceValue: { Stop: [{ hooks: [command] }] },
				workspaceFolderValue: { preToolUse: [command] },
			}),
		} as unknown as vscode.WorkspaceConfiguration)
		expect(readCompletionHookConfig()).toEqual({ stop: [], subagentStop: [] })
	})

	it("selects a Windows executable override without enabling shell commands", () => {
		const config = parseLifecycleHookConfig({ stop: [{ command: "relative", commandWindows: process.execPath }] })
		expect(config.stop).toEqual(process.platform === "win32" ? [{ command: process.execPath }] : [])
		expect(parseLifecycleHookConfig({ stop: [{ ...command, commandWindows: "relative" }] }).stop).toEqual(
			process.platform === "win32" ? [] : [command],
		)
	})

	it("captures MCP templates and async commands without widening handler authority", () => {
		const input = { path: "${tool_input.path}", nested: ["value"] }
		const config = parseLifecycleHookConfig({
			PreToolUse: [{ matcher: "Bash", hooks: [{ type: "mcp_tool", server: "policy", tool: "inspect", input }] }],
			PostToolUse: [{ hooks: [{ ...command, type: "command", async: true, additionalContextLimit: 0 }] }],
			SessionEnd: [
				{
					hooks: [
						{ type: "mcp_tool", server: "policy", tool: "end" },
						{ ...command, async: true },
					],
				},
			],
		})
		input.nested.push("changed")
		expect(config.preToolUse).toEqual([
			{
				type: "mcp_tool",
				server: "policy",
				tool: "inspect",
				input: { path: "${tool_input.path}", nested: ["value"] },
				matcher: "Bash",
			},
		])
		expect(config.postToolUse).toEqual([{ ...command, type: "command", async: true, additionalContextLimit: 0 }])
		expect(config.sessionEnd).toEqual([command])
	})

	it("rejects malformed matchers, handlers, and timer values without dropping valid siblings", () => {
		const config = parseLifecycleHookConfig({
			PreToolUse: [
				{ matcher: "[", hooks: [command] },
				{
					hooks: [
						{ command: "relative" },
						{ ...command, timeoutMs: 2_147_483_648 },
						{ ...command, timeout: 0 },
						{ ...command, args: [3] },
					],
				},
				{
					hooks: [
						{ ...command, timeoutMs: 1 },
						{ ...command, timeout: 601 },
					],
				},
			],
		})
		expect(config.preToolUse).toEqual([
			{ ...command, timeoutMs: 1 },
			{ ...command, timeoutMs: 601_000 },
		])
	})

	it("retains later matcher groups after the first eight handlers", () => {
		const validator = { ...command, args: ["patch-validator.js"] }
		const config = parseLifecycleHookConfig({
			PreToolUse: [
				{ matcher: "read_file", hooks: Array.from({ length: 8 }, () => command) },
				{ matcher: "apply_patch", hooks: [validator] },
			],
		})
		expect(config.preToolUse).toHaveLength(9)
		expect(
			selectLifecycleHookCommands(config, { hook_event_name: "PreToolUse", tool_name: "apply_patch" }),
		).toEqual([{ ...validator, matcher: "apply_patch" }])
	})

	it("rejects event overflow explicitly instead of retaining a partial hook configuration", () => {
		expect(() =>
			parseLifecycleHookConfig({ Stop: [{ hooks: Array.from({ length: 257 }, () => command) }] }),
		).toThrow(/Stop.*256/)
	})
})

describe("lifecycle hook matching", () => {
	it.each(["exec_command", "execute_command", "Bash"])("matches Bash aliases for %s", (tool_name) => {
		const config = parseLifecycleHookConfig({ PreToolUse: [{ matcher: "^Bash$", hooks: [command] }] })
		expect(selectLifecycleHookCommands(config, { hook_event_name: "PreToolUse", tool_name })).toHaveLength(1)
		expect(selectLifecycleHookCommands(config, { hook_event_name: "PreToolUse", tool_name: "read_file" })).toEqual(
			[],
		)
	})

	it.each(["apply_patch", "apply_diff", "edit_file", "write_to_file"])("matches edit aliases for %s", (tool_name) => {
		const config = parseLifecycleHookConfig({ PostToolUse: [{ matcher: "Edit|Write", hooks: [command] }] })
		expect(selectLifecycleHookCommands(config, { hook_event_name: "PostToolUse", tool_name })).toHaveLength(1)
	})

	it("matches the Agent alias for native subagent spawning", () => {
		const config = parseLifecycleHookConfig({ PreToolUse: [{ matcher: "Agent", hooks: [command] }] })
		expect(
			selectLifecycleHookCommands(config, { hook_event_name: "PreToolUse", tool_name: "spawn_agent" }),
		).toHaveLength(1)
	})

	it("treats simple name alternatives as exact and other expressions as regex", () => {
		const exact = parseLifecycleHookConfig({
			PreToolUse: [{ matcher: "read_file|search_files", hooks: [command] }],
		})
		expect(
			selectLifecycleHookCommands(exact, { hook_event_name: "PreToolUse", tool_name: "read_file_extra" }),
		).toEqual([])
		const regex = parseLifecycleHookConfig({ PreToolUse: [{ matcher: "mcp__filesystem__.*", hooks: [command] }] })
		expect(
			selectLifecycleHookCommands(regex, { hook_event_name: "PreToolUse", tool_name: "mcp__filesystem__read" }),
		).toHaveLength(1)
	})

	it("uses event-specific matcher fields and ignores matchers for Stop, prompts, and Interrupt", () => {
		const config = parseLifecycleHookConfig({
			SessionStart: [{ matcher: "startup|resume", hooks: [command] }],
			PreCompact: [{ matcher: "auto", hooks: [command] }],
			SubagentStop: [{ matcher: "worker", hooks: [command] }],
			SessionEnd: [{ matcher: "other", hooks: [command] }],
			Stop: [{ matcher: "never", hooks: [command] }],
			UserPromptSubmit: [{ matcher: "never", hooks: [command] }],
			Interrupt: [{ matcher: "never", hooks: [command] }],
		})
		expect(
			selectLifecycleHookCommands(config, { hook_event_name: "SessionStart", source: "startup" }),
		).toHaveLength(1)
		expect(selectLifecycleHookCommands(config, { hook_event_name: "SessionStart", source: "compact" })).toEqual([])
		expect(selectLifecycleHookCommands(config, { hook_event_name: "PreCompact", trigger: "auto" })).toHaveLength(1)
		expect(
			selectLifecycleHookCommands(config, { hook_event_name: "SubagentStop", agent_type: "worker" }),
		).toHaveLength(1)
		expect(selectLifecycleHookCommands(config, { hook_event_name: "SessionEnd", reason: "other" })).toHaveLength(1)
		for (const hook_event_name of ["Stop", "UserPromptSubmit", "Interrupt"] as const)
			expect(selectLifecycleHookCommands(config, { hook_event_name })).toHaveLength(1)
	})
})
