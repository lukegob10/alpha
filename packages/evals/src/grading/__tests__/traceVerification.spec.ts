import { describe, expect, it, vi } from "vitest"

import { VirtualClock } from "../../testing/hostileRuntime"
import { createDefaultGraderRegistry, resolveGraderAlias, type EvalTraceEvent, type GraderContext } from "../index"

const command = { command: "pnpm", args: ["test"] }
const event = (sequence: number, type: string, payload: unknown): EvalTraceEvent => ({
	sequence,
	type: `agent.turn.${type}`,
	timestamp: "2026-10-23T00:00:00Z",
	payload,
})
const write = (sequence: number, status = "success", name = "apply_patch") =>
	event(sequence, "tool_result", { callId: `write-${sequence}`, name, status })
const annotation = (sequence: number, status = "success", callId = `verify-${sequence}`) =>
	event(sequence, "verification_result", { callId, toolName: "exec_command", status, ...command })
const verify = (sequence: number, status = "success", callId = `verify-${sequence}`) => [
	event(sequence, "tool_result", {
		callId,
		name: "exec_command",
		status,
		...command,
		exitCode: status === "success" ? 0 : 1,
	}),
	annotation(sequence, status, callId),
]

async function grade(alias: string, trace: Array<EvalTraceEvent | EvalTraceEvent[]>, changedPaths = ["src/result.ts"]) {
	const context: GraderContext = {
		workspaceRoot: process.cwd(),
		changedPaths,
		trace: trace.flat().map((entry, index) => ({ ...entry, sequence: index + 1 })),
		clock: new VirtualClock(),
		processRunner: { run: vi.fn() },
	}
	return createDefaultGraderRegistry().execute(
		[resolveGraderAlias({ alias, taskId: "task", visibleCommands: [command] })],
		context,
	)
}

describe.each(["validation_after_edit", "validation_after_last_edit"])("%s semantic verification", (alias) => {
	it("rejects read, failed verification, then an unverified mutation", async () => {
		const result = await grade(alias, [
			event(1, "tool_result", { callId: "read", name: "read_file", status: "success" }),
			verify(2, "error"),
			write(3),
		])
		expect(result.decision).toBe("outcome_failed")
	})

	it("accepts earlier failed verification followed by successful verification of the final mutation", async () => {
		expect((await grade(alias, [write(1), verify(2, "error"), write(3), verify(4)])).decision).toBe("passed")
	})

	it("rejects verification which precedes the final successful mutation", async () => {
		expect((await grade(alias, [write(1), verify(2), write(3)])).decision).toBe("outcome_failed")
	})

	it.each(["error", "denied", "cancelled"])("does not accept %s verification", async (status) => {
		expect((await grade(alias, [write(1), verify(2, status)])).decision).toBe("outcome_failed")
	})

	it.each(["write_file", "edit_file", "apply_diff"])("allows a legitimate %s edit workflow", async (name) => {
		expect((await grade(alias, [write(1, "success", name), verify(2)])).decision).toBe("passed")
	})

	it.each(["error", "denied", "cancelled"])(
		"does not invalidate completed verification for a later %s edit",
		async (status) => {
			expect((await grade(alias, [write(1), verify(2), write(3, status)])).decision).toBe("passed")
		},
	)

	it("requires successful verification without demanding a mutation for a no-change task", async () => {
		expect((await grade(alias, [verify(1)], [])).decision).toBe("passed")
		expect((await grade(alias, [verify(1, "error")], [])).decision).toBe("outcome_failed")
	})

	it("does not substitute a successful unrelated command for the required verifier", async () => {
		expect(
			(
				await grade(alias, [
					write(1),
					event(2, "tool_result", {
						callId: "different-command",
						name: "exec_command",
						status: "success",
						exitCode: 0,
						command: "git",
						args: ["status"],
					}),
				])
			).decision,
		).toBe("outcome_failed")
	})

	it("rejects a success annotation contradicted by its terminal tool receipt", async () => {
		expect(
			(
				await grade(alias, [
					write(1),
					event(2, "tool_result", {
						callId: "verify",
						name: "exec_command",
						status: "cancelled",
						...command,
					}),
					annotation(3, "success", "verify"),
				])
			).decision,
		).toBe("outcome_failed")
	})

	it("does not recycle a verifier receipt from before the final mutation", async () => {
		expect(
			(
				await grade(alias, [
					event(1, "tool_result", { callId: "verify", name: "exec_command", status: "success", ...command }),
					write(2),
					annotation(3, "success", "verify"),
				])
			).decision,
		).toBe("outcome_failed")
	})

	it("accepts the required command through a native terminal receipt and rejects a later failure", async () => {
		const receipt = event(2, "tool_result", {
			callId: "verify",
			name: "exec_command",
			status: "success",
			input: { cmd: 'pnpm "test"' },
			exitCode: 0,
		})
		expect((await grade(alias, [write(1), receipt])).decision).toBe("passed")
		expect((await grade(alias, [write(1), receipt, verify(3, "error")])).decision).toBe("outcome_failed")
	})

	it.each(["pnpm test; echo ok", "pnpm test || true", "pnpm test && echo ok\ntrue"])(
		"does not infer command success from a masking shell expression: %s",
		async (cmd) => {
			expect(
				(
					await grade(alias, [
						write(1),
						event(2, "tool_result", {
							callId: "verify",
							name: "exec_command",
							status: "success",
							input: { cmd },
							exitCode: 0,
						}),
					])
				).decision,
			).toBe("outcome_failed")
		},
	)

	it("does not count a yielded command session as completed verification", async () => {
		expect(
			(
				await grade(alias, [
					write(1),
					event(2, "tool_result", {
						callId: "running",
						name: "exec_command",
						status: "success",
						...command,
					}),
				])
			).decision,
		).toBe("outcome_failed")
	})

	it("rejects a successful annotation with no matching terminal command receipt", async () => {
		expect((await grade(alias, [write(1), annotation(2)])).decision).toBe("outcome_failed")
	})

	it("does not accept command-shaped metadata on a read tool", async () => {
		expect(
			(
				await grade(alias, [
					write(1),
					event(2, "tool_result", {
						callId: "read",
						name: "read_file",
						status: "success",
						exitCode: 0,
						...command,
					}),
				])
			).decision,
		).toBe("outcome_failed")
	})
})

describe("canonical retry and plan aliases", () => {
	it("counts canonical retries rather than an unrelated bare event name", async () => {
		expect(
			(
				await grade(
					"trace_retry_budget",
					Array.from({ length: 4 }, (_, index) => event(index + 1, "retry", { attempt: index + 1 })),
				)
			).decision,
		).toBe("outcome_failed")
	})

	it("checks the canonical retained-plan annotation", async () => {
		expect((await grade("plan_continuity", [event(1, "plan_retained", {})])).decision).toBe("passed")
	})
})
