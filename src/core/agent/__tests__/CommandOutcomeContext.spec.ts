import { describe, expect, it } from "vitest"

import type { CommandExecutionEvidence } from "../../task/Task"
import { formatBackgroundCommandContext } from "../CommandOutcomeContext"

const command = (overrides: Partial<CommandExecutionEvidence> = {}): CommandExecutionEvidence => ({
	toolCallId: "call",
	executionId: "execution",
	status: "succeeded",
	exitCode: 0,
	startedAt: 1,
	returnedInBackground: true,
	...overrides,
})

describe("background command outcome projection", () => {
	it.each(["running", "succeeded", "failed", "denied", "cancelled", "timed_out"] as const)(
		"preserves the recorded %s outcome without inferring test coverage",
		(status) => {
			const text = formatBackgroundCommandContext([command({ status, exitCode: undefined })])!
			expect(JSON.parse(text.split("\n")[1])).toEqual({
				tool_call_id: "call",
				execution_id: "execution",
				status,
				exit_code: null,
			})
			expect(text).toContain("not later edits or overall task completion")
		},
	)

	it("retains signal termination and distinguishes retries with the same call ID", () => {
		const first = formatBackgroundCommandContext([command({ status: "failed", signalName: "SIGTERM" })])!
		expect(first).toContain('"signal":"SIGTERM"')
		const retried = formatBackgroundCommandContext([command({ executionId: "retry" })])
		expect(retried).not.toBe(formatBackgroundCommandContext([command()]))
	})

	it("never projects command text, paths, output, or captured file contents", () => {
		const text = formatBackgroundCommandContext([
			command({
				command: "private-command",
				cwd: "private-directory",
				verificationChangeSetIds: ["private-change"],
				verificationVersions: {},
			}),
		])!
		expect(text).not.toContain("private-")
		expect(text).not.toContain("verification")
	})

	it("bounds recent outcomes and reports omission without truncating identities", () => {
		const evidence = Array.from({ length: 128 }, (_, index) =>
			command({ toolCallId: `call-${index}`, executionId: `execution-${index}` }),
		)
		evidence.push(command({ toolCallId: "x".repeat(257) }))
		const text = formatBackgroundCommandContext(evidence)!
		expect(text).not.toContain('"tool_call_id":"call-119"')
		expect(text).toContain('"tool_call_id":"call-120"')
		expect(text).toContain('"tool_call_id":"call-127"')
		expect(text).toContain("121 additional outcomes omitted")
		expect(text.split("\n").filter((line) => line.startsWith("{")).length).toBe(8)
		expect(text.length).toBeLessThan(8_192)
	})

	it("escapes provider identifiers and omits foreground or legacy records", () => {
		const text = formatBackgroundCommandContext([command({ toolCallId: 'call\n"injected"' })])!
		expect(text.split("\n")).toHaveLength(2)
		expect(JSON.parse(text.split("\n")[1]).tool_call_id).toBe('call\n"injected"')
		expect(formatBackgroundCommandContext([command({ returnedInBackground: undefined })])).toBeUndefined()
		expect(formatBackgroundCommandContext([])).toBeUndefined()
	})

	it("keeps complete outcomes within the byte budget even when JSON escaping expands identifiers", () => {
		const toolCallId = '\u0000"'.repeat(128)
		const executionId = "\\\n".repeat(128)
		const text = formatBackgroundCommandContext(
			Array.from({ length: 128 }, () => command({ toolCallId, executionId, signalName: "\u0001".repeat(64) })),
		)!
		expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(8_192)
		const rows = text.split("\n").filter((line) => line.startsWith("{"))
		expect(rows.length).toBeGreaterThan(0)
		for (const row of rows)
			expect(JSON.parse(row)).toMatchObject({ tool_call_id: toolCallId, execution_id: executionId })
		expect(text).toContain("additional outcomes omitted")
	})
})
