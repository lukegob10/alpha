import { describe, expect, it, vi } from "vitest"
import {
	runCompletionHooks,
	runLifecycleHooks,
	type CompletionHookRequest,
	type LifecycleHookOutcome,
	type CompletionHookRuntimeOptions,
} from "../CompletionHooks"
import type { CompletionHookCommand } from "../LifecycleHookConfig"

const request: CompletionHookRequest = {
	hook_event_name: "Stop",
	session_id: "dispatch-session",
	turn_id: "dispatch-turn",
	cwd: process.cwd(),
	model: "fixture",
	stop_hook_active: false,
	last_assistant_message: "Finished",
	permission_mode: "ask",
	transcript_path: null,
}

function command(output: object): CompletionHookCommand {
	return {
		command: process.execPath,
		args: ["-e", `process.stdout.write(${JSON.stringify(JSON.stringify(output))})`],
	}
}

describe("native hook dispatch", () => {
	it("combines command and MCP Stop feedback in configured order", async () => {
		const executeMcp = vi.fn<NonNullable<CompletionHookRuntimeOptions["executeMcp"]>>(async () => ({
			exitCode: 0,
			stdout: JSON.stringify({ decision: "block", reason: "Inspect the test output" }),
			stderr: "",
		}))
		const outcome = await runCompletionHooks(
			{
				stop: [
					command({ decision: "block", reason: "Repair the implementation" }),
					{ type: "mcp_tool", server: "checks", tool: "verify" },
				],
				subagentStop: [],
			},
			request,
			new AbortController().signal,
			{ executeMcp },
		)
		expect(outcome.prompt).toBe("Repair the implementation\n\nInspect the test output")
		expect(outcome.fragments).toHaveLength(2)
		expect(executeMcp).toHaveBeenCalledOnce()
	})

	it("filters handlers before dispatch and delivers MCP lifecycle context", async () => {
		const executeMcp = vi.fn<NonNullable<CompletionHookRuntimeOptions["executeMcp"]>>(async () => ({
			exitCode: 0,
			stdout: JSON.stringify({
				hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "Review current evidence" },
			}),
			stderr: "",
		}))
		const outcome = await runLifecycleHooks(
			{
				stop: [],
				subagentStop: [],
				preToolUse: [
					{ type: "mcp_tool", server: "checks", tool: "skip", matcher: "Read" },
					{ type: "mcp_tool", server: "checks", tool: "verify", matcher: "^Bash$" },
				],
			},
			{
				...request,
				hook_event_name: "PreToolUse",
				tool_name: "Bash",
				tool_use_id: "exec-1",
				tool_input: { command: "pnpm test" },
			},
			new AbortController().signal,
			{ executeMcp },
		)
		expect(executeMcp).toHaveBeenCalledOnce()
		expect(executeMcp.mock.calls[0][0]).toMatchObject({ tool: "verify" })
		expect(outcome.additionalContext).toEqual([
			{ hook_run_id: expect.any(String), text: "Review current evidence" },
		])
	})

	it("schedules background context without waiting or applying its controls", async () => {
		let background!: (signal: AbortSignal) => Promise<LifecycleHookOutcome>
		const scheduleAsync = vi.fn((_event, run) => {
			background = run
			return true
		})
		const original = new AbortController()
		const input = { ...request, hook_event_name: "SessionStart" as const, source: "startup" as const }
		expect(
			await runLifecycleHooks(
				{
					stop: [],
					subagentStop: [],
					sessionStart: [
						{
							...command({
								continue: false,
								hookSpecificOutput: {
									hookEventName: "SessionStart",
									additionalContext: "Background evidence",
								},
							}),
							async: true,
						},
					],
				},
				input,
				original.signal,
				{ scheduleAsync },
			),
		).toEqual({ warnings: [] })
		expect(scheduleAsync).toHaveBeenCalledOnce()
		original.abort()
		const outcome = await background(new AbortController().signal)
		expect(outcome.shouldStop).toBeUndefined()
		expect(outcome.additionalContext?.[0].text).toBe("Background evidence")
	})

	it("never turns a background Stop block into a live continuation", async () => {
		let background!: (signal: AbortSignal) => Promise<LifecycleHookOutcome>
		expect(
			await runCompletionHooks(
				{
					stop: [
						{
							...command({ decision: "block", reason: "Async feedback cannot restart the turn" }),
							async: true,
						},
					],
					subagentStop: [],
				},
				request,
				new AbortController().signal,
				{
					scheduleAsync: (_event, run) => {
						background = run
						return true
					},
				},
			),
		).toEqual({ warnings: [] })
		expect(await background(new AbortController().signal)).toEqual({ warnings: [] })
	})
})
