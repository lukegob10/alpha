import * as vscode from "vscode"
import * as fs from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it, vi } from "vitest"
import {
	readCompletionHookConfig,
	runCompletionHooks,
	type CompletionHookConfig,
	type CompletionHookRequest,
} from "../CompletionHooks"

const request: CompletionHookRequest = {
	hook_event_name: "Stop",
	session_id: "root-task",
	turn_id: "turn-1",
	cwd: process.cwd(),
	model: "test-model",
	stop_hook_active: false,
	last_assistant_message: "Finished.",
	permission_mode: "ask",
	transcript_path: null,
}

function command(source: string, timeoutMs?: number) {
	return { command: process.execPath, args: ["-e", source], timeoutMs }
}

describe("completion hooks", () => {
	it("loads only valid commands from the Alpha setting", () => {
		vi.spyOn(vscode.workspace, "getConfiguration").mockImplementation(
			() =>
				({
					get: () => ({
						stop: [
							{ command: process.execPath },
							{ command: "" },
							{ command: "node" },
							{ command: "invalid", args: [4] },
						],
					}),
				}) as any,
		)
		expect(readCompletionHookConfig()).toEqual({ stop: [{ command: process.execPath }], subagentStop: [] })
		vi.restoreAllMocks()
	})

	it("keeps the no-hook baseline and selects only the matching event", async () => {
		const config: CompletionHookConfig = {
			stop: [],
			subagentStop: [command("process.stdout.write(JSON.stringify({decision:'block',reason:'Child only'}))")],
		}
		expect(await runCompletionHooks(config, request, new AbortController().signal)).toEqual({ warnings: [] })
		expect(
			await runCompletionHooks(
				config,
				{
					...request,
					hook_event_name: "SubagentStop",
					agent_id: "child-task",
					agent_type: "worker",
				},
				new AbortController().signal,
			),
		).toEqual({
			prompt: "Child only",
			fragments: [{ hook_run_id: expect.any(String), text: "Child only" }],
			warnings: [],
		})
	})

	it("combines blocking feedback into one bounded prompt", async () => {
		const config: CompletionHookConfig = {
			stop: [
				command("process.stdout.write(JSON.stringify({decision:'block',reason:'First check'}))"),
				command("process.stderr.write('Second check');process.exitCode=2"),
			],
			subagentStop: [],
		}
		expect(await runCompletionHooks(config, request, new AbortController().signal)).toEqual({
			prompt: "First check\n\nSecond check",
			fragments: [
				{ hook_run_id: expect.any(String), text: "First check" },
				{ hook_run_id: expect.any(String), text: "Second check" },
			],
			warnings: [],
		})
	})

	it("warns and ignores a promptless block or malformed output", async () => {
		const config: CompletionHookConfig = {
			stop: [
				command("process.stdout.write(JSON.stringify({decision:'block'}))"),
				command("process.stdout.write('not json')"),
			],
			subagentStop: [],
		}
		expect(await runCompletionHooks(config, request, new AbortController().signal)).toEqual({
			warnings: [
				"Completion hook requested continuation without a prompt; ignoring the block.",
				"Completion hook returned invalid JSON output.",
			],
		})
	})

	it("bounds a hung process and honors preexisting cancellation", async () => {
		const config: CompletionHookConfig = {
			stop: [command("setInterval(()=>{},1000)", 100)],
			subagentStop: [],
		}
		expect(await runCompletionHooks(config, request, new AbortController().signal)).toEqual({
			warnings: ["Completion hook timed out."],
		})
		const controller = new AbortController()
		controller.abort()
		expect(await runCompletionHooks(config, request, controller.signal)).toEqual({ warnings: [] })
	})

	it("kills an in-flight hook when the task is cancelled", async () => {
		const config: CompletionHookConfig = {
			stop: [command("setInterval(()=>{},1000)", 30_000)],
			subagentStop: [],
		}
		const controller = new AbortController()
		const pending = runCompletionHooks(config, request, controller.signal)
		controller.abort()
		expect(await pending).toEqual({ warnings: [] })
	})

	it.each(["Stop", "SubagentStop"] as const)(
		"lets universal continue:false override a block for %s",
		async (hook_event_name) => {
			const config: CompletionHookConfig = {
				stop: [
					command(
						"process.stdout.write(JSON.stringify({continue:false,stopReason:'Stop now',decision:'block',reason:'Ignore'}))",
					),
				],
				subagentStop: [
					command(
						"process.stdout.write(JSON.stringify({continue:false,stopReason:'Stop now',decision:'block',reason:'Ignore'}))",
					),
				],
			}
			expect(
				await runCompletionHooks(config, { ...request, hook_event_name }, new AbortController().signal),
			).toEqual({ shouldStop: true, stopReason: "Stop now", warnings: [] })
		},
	)

	it("collects systemMessage while accepting suppressOutput", async () => {
		const config: CompletionHookConfig = {
			stop: [command("process.stdout.write(JSON.stringify({systemMessage:'Hook note',suppressOutput:true}))")],
			subagentStop: [],
		}
		expect(await runCompletionHooks(config, request, new AbortController().signal)).toEqual({
			warnings: ["Hook note"],
		})
	})

	it("starts independent hooks together and aggregates feedback in configuration order", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-hooks-parallel-"))
		try {
			const source = (name: string, other: string) =>
				`const fs=require('fs');const path=require('path');const dir=${JSON.stringify(directory)};` +
				`fs.writeFileSync(path.join(dir,${JSON.stringify(name)}),'ready');` +
				`const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,${JSON.stringify(other)}))){` +
				`clearInterval(timer);process.stdout.write(JSON.stringify({decision:'block',reason:${JSON.stringify(name)}}))}},10)`
			const config: CompletionHookConfig = {
				stop: [command(source("first", "second"), 2_000), command(source("second", "first"), 2_000)],
				subagentStop: [],
			}
			const outcome = await runCompletionHooks(config, request, new AbortController().signal)
			expect(outcome).toEqual({
				prompt: "first\n\nsecond",
				fragments: [
					{ hook_run_id: expect.any(String), text: "first" },
					{ hook_run_id: expect.any(String), text: "second" },
				],
				warnings: [],
			})
			expect(outcome.fragments?.[0].hook_run_id).not.toBe(outcome.fragments?.[1].hook_run_id)
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("terminates a spawned descendant when the hook is cancelled", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-hook-tree-"))
		const pidFile = path.join(directory, "descendant.pid")
		const source =
			`const fs=require('fs');const {spawn}=require('child_process');` +
			`const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
			`fs.writeFileSync(${JSON.stringify(pidFile)},String(child.pid));setInterval(()=>{},1000)`
		const config: CompletionHookConfig = { stop: [command(source, 30_000)], subagentStop: [] }
		const controller = new AbortController()
		let descendantPid: number | undefined
		try {
			const pending = runCompletionHooks(config, request, controller.signal)
			await vi.waitFor(
				async () => {
					descendantPid = Number(await fs.readFile(pidFile, "utf8"))
					expect(descendantPid).toBeGreaterThan(0)
				},
				{ timeout: 3_000 },
			)
			expect(() => process.kill(descendantPid!, 0)).not.toThrow()
			controller.abort()
			expect(await pending).toEqual({ warnings: [] })
			await vi.waitFor(
				() => {
					expect(() => process.kill(descendantPid!, 0)).toThrow()
				},
				{ timeout: 3_000 },
			)
		} finally {
			controller.abort()
			if (descendantPid) {
				try {
					process.kill(descendantPid, "SIGKILL")
				} catch {
					// The descendant exited with its hook.
				}
			}
			await fs.rm(directory, { recursive: true, force: true })
		}
	})

	it("caps simultaneous hook processes at four", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-hook-cap-"))
		const release = path.join(directory, "release")
		const config: CompletionHookConfig = {
			stop: Array.from({ length: 5 }, (_, index) =>
				command(
					`const fs=require('fs');fs.writeFileSync(${JSON.stringify(path.join(directory, String(index)))},'ready');` +
						`const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer)}},10)`,
					3_000,
				),
			),
			subagentStop: [],
		}
		const controller = new AbortController()
		try {
			const pending = runCompletionHooks(config, request, controller.signal)
			await vi.waitFor(
				async () => {
					const files = await fs.readdir(directory)
					expect(files.filter((file) => /^\d$/.test(file))).toHaveLength(4)
				},
				{ timeout: 3_000 },
			)
			await expect(fs.access(path.join(directory, "4"))).rejects.toThrow()
			await fs.writeFile(release, "go")
			expect(await pending).toEqual({ warnings: [] })
			expect(await fs.readdir(directory)).toContain("4")
		} finally {
			controller.abort()
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
})
