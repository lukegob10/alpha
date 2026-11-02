import { describe, expect, it } from "vitest"
import { applyHookToolInput, getHookToolIdentity } from "../HookToolIdentity"

describe("native hook tool identities", () => {
	it.each(["exec_command", "execute_command", "shell"])("exposes %s as Bash with command input", (name) => {
		expect(
			getHookToolIdentity({ name, arguments: { cmd: "pnpm test", tty: true, workdir: "/workspace" } }),
		).toEqual({
			name: "Bash",
			matcherAliases: [],
			input: { command: "pnpm test" },
		})
	})

	it("keeps patch identity separate from compatibility matcher aliases", () => {
		expect(getHookToolIdentity({ name: "apply_patch", arguments: { patch: "patch contents" } })).toEqual({
			name: "apply_patch",
			matcherAliases: ["Write", "Edit"],
			input: { command: "patch contents" },
		})
		expect(getHookToolIdentity({ name: "spawn_agent", arguments: { task_name: "review" } })).toEqual({
			name: "spawn_agent",
			matcherAliases: ["Agent"],
			input: { task_name: "review" },
		})
	})

	it("normalizes provider MCP separators only for hook presentation", () => {
		expect(getHookToolIdentity({ name: "mcp--files--read_file", arguments: { path: "file.ts" } })).toEqual({
			name: "mcp__files__read_file",
			matcherAliases: [],
			input: { path: "file.ts" },
		})
	})

	it("rewrites only native command text and preserves approval-relevant arguments", () => {
		const original = { cmd: "pnpm test", workdir: "/workspace", tty: true, max_output_tokens: 500 }
		expect(
			applyHookToolInput(
				{ name: "exec_command", arguments: original },
				{ command: "pnpm test --run", workdir: "/outside", tty: false },
			),
		).toEqual({ ...original, cmd: "pnpm test --run" })
		expect(original.cmd).toBe("pnpm test")
		expect(
			applyHookToolInput(
				{ name: "execute_command", arguments: { command: "before", cwd: "." } },
				{ command: "after" },
			),
		).toEqual({
			command: "after",
			cwd: ".",
		})
		expect(
			applyHookToolInput({ name: "apply_patch", arguments: { patch: "before" } }, { command: "after" }),
		).toEqual({ patch: "after" })
	})

	it("keeps prepared command aliases consistent when rewriting before approval", () => {
		const original = { cmd: "before", command: "before", workdir: "/workspace", tty: true }
		expect(
			applyHookToolInput(
				{ name: "exec_command", arguments: original },
				{ command: "after", workdir: "/outside" },
			),
		).toEqual({ ...original, cmd: "after", command: "after" })
		expect(original).toEqual({ cmd: "before", command: "before", workdir: "/workspace", tty: true })
	})

	it.each(["exec_command", "apply_patch"])("rejects malformed %s rewrites", (name) => {
		expect(() => applyHookToolInput({ name, arguments: {} }, { command: 1 })).toThrow("requires command")
	})
})
