import { describe, expect, it, vi } from "vitest"

import type { Task } from "../../task/Task"
import { ToolRegistry, type ToolDescriptor } from "../../tools/ToolRegistry"
import type { AgentTurnEvent } from "../AgentTurnEvents"
import { ToolScheduler, type ToolSchedulerOptions } from "../ToolScheduler"
import { createToolPolicySnapshot } from "../ToolPolicy"

async function runCommand(command: string, overrides: Partial<ToolSchedulerOptions> = {}, exitCode = 0) {
	const receipts: unknown[] = []
	const task = {
		abort: false,
		cwd: process.cwd(),
		taskId: "verification-test",
		userMessageContent: [],
		ask: async () => ({ response: "yesButtonClicked" }),
		say: async () => {},
		recordToolUsage: () => {},
		pushToolResultToUserContent: (receipt: unknown) => receipts.push(receipt),
	} as unknown as Task
	const events: AgentTurnEvent[] = []
	const execute = vi.fn<ToolDescriptor["execute"]>(async ({ callbacks }) => {
		callbacks.setResultMetadata?.({ status: exitCode === 0 ? "success" : "error", exitCode })
		callbacks.pushToolResult("actual command output")
	})
	const registry = new ToolRegistry({ includeBuiltIns: false })
	const descriptor: ToolDescriptor = {
		name: "execute_command",
		aliases: [],
		schema: {
			type: "function",
			function: { name: "execute_command", description: "command", parameters: { type: "object" } },
		},
		capabilities: {
			concurrency: "serial",
			sideEffects: "task",
			controlFlow: false,
			requiresApproval: false,
			parallelCommandRead: true,
		},
		prepareParallelCommand: async (context) => ({
			scope: process.cwd(),
			run: async (callbacks) => {
				await execute({ ...context, callbacks: { ...context.callbacks, ...callbacks } })
				return async () => {}
			},
		}),
		execute,
	}
	registry.register(descriptor)
	const scheduler = new ToolScheduler({
		task,
		registry,
		mode: "code",
		validateCall: () => {},
		...(overrides.deferResultCommit
			? {
					executionMode: "selective-parallel" as const,
					requirePreparedCommandRead: true,
					policy: createToolPolicySnapshot({
						visibleTools: ["execute_command"],
						capabilities: { execute_command: descriptor.capabilities },
					}),
				}
			: {}),
		onEvent: (event) => {
			events.push(event)
		},
		...overrides,
	})
	const call = {
		type: "tool_call" as const,
		id: "command",
		name: overrides.deferResultCommit ? "exec_command" : "execute_command",
		arguments: overrides.deferResultCommit ? { cmd: command } : { command },
	}
	const outcome = await scheduler.run({ items: [call], toolCalls: [call], text: "", reasoning: "" })
	if (overrides.deferResultCommit) await scheduler.commitDeferredResults()
	return {
		outcome,
		receipts,
		execute,
		events,
		verification: events.filter((event) => event.type === "verification_result"),
	}
}

describe("ToolScheduler command verification evidence", () => {
	it.each([
		"cat latest.log",
		"echo test",
		"echo build",
		"echo lint",
		"echo typecheck",
		"rg test package.json",
		"cat test-results.json",
		"git show HEAD:build.ts",
		"node scripts/latest.js",
		"pnpm install test",
		"pnpm --filter test list",
		"npm exec -- echo test",
		"bash -lc 'echo test'",
		"pwsh -NoProfile -Command 'Get-Content latest.log'",
		"pnpm test --help",
		"pytest --version",
		"pytest --collect-only",
		"cargo test --no-run",
		"jest --listTests",
		"tsc --showConfig",
		"npm test --ignore-scripts",
		"test -f package.json",
		"pnpm run contest",
		"pnpm run rebuild-index",
		"pnpm format",
		"pnpm format:write",
		"pnpm format:fix",
		"pnpm format:check:write",
		"npm run format",
		"yarn format:write",
		"prettier --write .",
		"pnpm test || echo passed",
		"echo passed || pnpm test",
		"pnpm test; echo passed",
		"pnpm test | cat",
		"pnpm test &",
		"pnpm test\necho passed",
		"if false; then pnpm test; fi",
		"$runner test",
		"pnpm $script",
		"pnpm test &&",
		"Set-Alias pnpm echo && pnpm test",
		"source setup.sh && pnpm test",
		"unknown-command && pnpm test",
		"echo 'pnpm test && pnpm build'",
	])("keeps receipts without inventing verification for %s", async (command) => {
		const result = await runCommand(command)
		expect(result.outcome.results[0]).toMatchObject({ status: "success", exitCode: 0 })
		expect(result.execute).toHaveBeenCalledOnce()
		expect(result.receipts).toHaveLength(1)
		expect(result.events.filter((event) => event.type === "tool_result")).toHaveLength(1)
		expect(result.verification).toEqual([])
	})

	it.each([
		["npm test", "test"],
		["pnpm --dir src test core/agent/example.spec.ts", "test"],
		["pnpm --filter @alpha-code/core test", "test"],
		["pnpm run test:unit", "test"],
		["npm run build", "build"],
		["yarn lint", "lint"],
		["pnpm format:check", "lint"],
		["pnpm check-types", "typecheck"],
		["pnpm typecheck", "typecheck"],
		["pnpm exec vitest run", "test"],
		["npx --no-install jest", "test"],
		["pytest tests/test_api.py", "test"],
		["python -m pytest", "test"],
		["node --test test/example.js", "test"],
		["go test ./...", "test"],
		["cargo test", "test"],
		["cargo build", "build"],
		["ruff check .", "lint"],
		["eslint src", "lint"],
		["prettier --check .", "lint"],
		["tsc --noEmit", "typecheck"],
		["/usr/local/bin/pnpm test", "test"],
		[
			process.platform === "win32" ? '& "C:\\Program Files\\nodejs\\pnpm.cmd" test' : '"/opt/node bin/pnpm" test',
			"test",
		],
		["bash -lc 'pnpm test'", "test"],
		['bash -lc "pnpm test && echo done"', "test"],
		['cmd /d /c "pnpm test"', "test"],
		["pwsh -NoProfile -Command 'pnpm test'", "test"],
		["cd src && pnpm test", "test"],
		["pnpm test && echo done", "test"],
		["pnpm build && pnpm test", "test"],
		["pnpm check-types > latest.log", "typecheck"],
	])("reports recognized invocation %s as %s", async (command, category) => {
		const { verification } = await runCommand(command)
		expect(verification).toEqual([
			expect.objectContaining({ commandCategory: category, status: "success", exitCode: 0 }),
		])
	})

	it("bounds nested launcher classification without changing execution", async () => {
		const { verification, execute } = await runCommand(`${"pnpm exec ".repeat(1_000)}vitest run`)
		expect(execute).toHaveBeenCalledOnce()
		expect(verification).toEqual([])
	})

	it("classifies the hook's effective command", async () => {
		const originalRead = await runCommand("cat latest.log", {
			preToolUse: async () => ({ updatedInput: { command: "pnpm test" } }),
		})
		expect(originalRead.verification).toEqual([expect.objectContaining({ commandCategory: "test" })])
		const originalTest = await runCommand("pnpm test", {
			preToolUse: async () => ({ updatedInput: { command: "cat latest.log" } }),
		})
		expect(originalTest.verification).toEqual([])
	})

	it("uses the same classification for deferred receipts", async () => {
		expect((await runCommand("cat latest.log", { deferResultCommit: true })).verification).toEqual([])
		expect((await runCommand("pnpm test", { deferResultCommit: true })).verification).toEqual([
			expect.objectContaining({ commandCategory: "test", status: "success" }),
		])
	})

	it("retains the actual failed process status", async () => {
		const { outcome, verification } = await runCommand("pnpm test", {}, 7)
		expect(outcome.results[0]).toMatchObject({ status: "error", exitCode: 7 })
		expect(verification).toEqual([
			expect.objectContaining({ commandCategory: "test", status: "error", exitCode: 7 }),
		])
	})

	it("does not treat replacement hook output as process verification", async () => {
		const { verification } = await runCommand("pnpm test", {
			postToolUse: async () => ({ blocked: "blocked by hook" }),
		})
		expect(verification).toEqual([])
	})
})
