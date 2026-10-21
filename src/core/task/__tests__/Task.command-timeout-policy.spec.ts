import * as vscode from "vscode"

import { resolveCommandTimeoutMs, createToolPolicySnapshot } from "../../agent/ToolPolicy"
import { Task } from "../Task"

afterEach(() => vi.restoreAllMocks())

function capture(timeoutSeconds: unknown, timeoutAllowlist: unknown = []) {
	vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
		get: (key: string, fallback: unknown) =>
			key === "commandExecutionTimeout"
				? timeoutSeconds
				: key === "commandTimeoutAllowlist"
					? timeoutAllowlist
					: fallback,
	} as vscode.WorkspaceConfiguration)
	const task = Object.assign(Object.create(Task.prototype), {
		workspacePath: process.cwd(),
		taskKind: "primary",
	}) as Task
	return task["captureToolExecutionPolicy"]({
		allowedCommands: ["rg"],
		deniedCommands: ["rm"],
	} as Parameters<Task["captureToolExecutionPolicy"]>[0])
}

describe("Task captured command timeout policy", () => {
	it("retains a validated timeout and immutable allowlist at the step boundary", () => {
		const allowlist = ["pnpm dev"]
		const execution = capture(2.5, allowlist)
		allowlist.push("rg")

		expect(execution.command).toEqual({
			allowedPrefixes: ["rg"],
			deniedPrefixes: ["rm"],
			userTimeoutMs: 2_500,
			timeoutAllowlist: ["pnpm dev"],
		})
		expect(Object.isFrozen(execution.command)).toBe(true)
		expect(Object.isFrozen(execution.command?.timeoutAllowlist)).toBe(true)
		const policy = createToolPolicySnapshot({ visibleTools: ["exec_command"], execution })
		expect(resolveCommandTimeoutMs(policy, 0, "rg needle fixture.txt")).toBe(2_500)
		expect(resolveCommandTimeoutMs(policy, 0, "pnpm dev")).toBe(0)
		expect(resolveCommandTimeoutMs(policy, 0, "pnpm developer")).toBe(2_500)
	})

	it.each([undefined, "5", -1, Number.NaN, Number.POSITIVE_INFINITY])(
		"defaults malformed configured timeout %s to disabled",
		(timeout) => {
			expect(capture(timeout).command?.userTimeoutMs).toBe(0)
		},
	)

	it("bounds configured timeouts and rejects malformed allowlist entries", () => {
		expect(capture(601, ["pnpm dev", 12, null]).command).toEqual(
			expect.objectContaining({ userTimeoutMs: 600_000, timeoutAllowlist: ["pnpm dev"] }),
		)
		expect(capture(1, "pnpm dev").command?.timeoutAllowlist).toEqual([])
	})
})
