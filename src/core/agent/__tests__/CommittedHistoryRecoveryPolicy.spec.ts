import { createAgentResponse, type AgentToolCall } from "../AgentResponse"
import { createToolFailure } from "../../tools/ToolFailure"
import {
	canContinueFromCommittedHistoryTools,
	type CommittedHistoryToolRecoveryInput,
} from "../CommittedHistoryRecoveryPolicy"

const call: AgentToolCall = { type: "tool_call", id: "read-1", name: "read_file", arguments: { path: "src/a.ts" } }

function settledRead(): CommittedHistoryToolRecoveryInput {
	return {
		response: createAgentResponse([call], { status: "incomplete", retryable: true }),
		toolIntentObserved: true,
		reservedToolCalls: [call],
		earlyReadDispatches: [
			{
				call,
				resultCommitStarted: true,
				receiptPersisted: true,
				outcome: {
					status: "completed",
					results: [{ callId: call.id, name: call.name, status: "success", content: "file", durationMs: 1 }],
				},
			},
		],
	}
}

describe("committed-history tool recovery admission", () => {
	it("continues after a settled paired read without replaying that call", () => {
		const input = settledRead()
		expect(canContinueFromCommittedHistoryTools(input)).toBe(true)
		expect(input.response.toolCalls).toEqual([call])
		expect(input.earlyReadDispatches[0]!.outcome!.results[0]!.content).toBe("file")
	})

	it("preserves text-only recovery and refuses unresolved tool intent", () => {
		const input: CommittedHistoryToolRecoveryInput = {
			response: createAgentResponse([{ type: "text", text: "Partial answer" }]),
			toolIntentObserved: false,
			reservedToolCalls: [],
			earlyReadDispatches: [],
		}
		expect(canContinueFromCommittedHistoryTools(input)).toBe(true)
		expect(canContinueFromCommittedHistoryTools({ ...input, toolIntentObserved: true })).toBe(false)
	})

	it("allows a known read error to remain an error in committed history", () => {
		const input = settledRead()
		input.earlyReadDispatches[0]!.outcome!.results[0]!.status = "error"
		expect(canContinueFromCommittedHistoryTools(input)).toBe(true)
	})

	it.each<[string, (input: CommittedHistoryToolRecoveryInput) => void]>([
		["unexecuted call", (input: CommittedHistoryToolRecoveryInput) => (input.earlyReadDispatches = [])],
		["unreserved call", (input: CommittedHistoryToolRecoveryInput) => (input.reservedToolCalls = [])],
		[
			"unpersisted result",
			(input: CommittedHistoryToolRecoveryInput) => (input.earlyReadDispatches[0]!.receiptPersisted = false),
		],
		[
			"uncommitted result",
			(input: CommittedHistoryToolRecoveryInput) => (input.earlyReadDispatches[0]!.resultCommitStarted = false),
		],
		[
			"unsettled dispatch",
			(input: CommittedHistoryToolRecoveryInput) => (input.earlyReadDispatches[0]!.outcome = undefined),
		],
		[
			"dispatch exception",
			(input: CommittedHistoryToolRecoveryInput) => (input.earlyReadDispatches[0]!.error = new Error("failed")),
		],
		[
			"cancelled scheduler",
			(input: CommittedHistoryToolRecoveryInput) => (input.earlyReadDispatches[0]!.outcome!.status = "aborted"),
		],
		[
			"failed scheduler",
			(input: CommittedHistoryToolRecoveryInput) => (input.earlyReadDispatches[0]!.outcome!.status = "failed"),
		],
		[
			"cleanup failure",
			(input: CommittedHistoryToolRecoveryInput) =>
				(input.earlyReadDispatches[0]!.outcome!.failure = {
					kind: "command_cleanup",
					callId: call.id,
					message: "unconfirmed cleanup",
				}),
		],
		[
			"missing result",
			(input: CommittedHistoryToolRecoveryInput) => (input.earlyReadDispatches[0]!.outcome!.results = []),
		],
		[
			"extra result",
			(input: CommittedHistoryToolRecoveryInput) =>
				input.earlyReadDispatches[0]!.outcome!.results.push(input.earlyReadDispatches[0]!.outcome!.results[0]!),
		],
	])("refuses %s even when terminal persistence succeeded", (_label, change) => {
		const input = settledRead()
		change(input)
		expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
	})

	it.each(["cancelled", "denied"] as const)("refuses a %s receipt", (status) => {
		const input = settledRead()
		input.earlyReadDispatches[0]!.outcome!.results[0]!.status = status
		expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
	})

	it.each(["running", "cancelled", "denied"] as const)("refuses %s command execution", (executionStatus) => {
		const input = settledRead()
		input.earlyReadDispatches[0]!.outcome!.results[0]!.executionStatus = executionStatus
		expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
	})

	it("refuses an indeterminate outcome even with a paired error receipt", () => {
		const input = settledRead()
		const result = input.earlyReadDispatches[0]!.outcome!.results[0]!
		result.status = "error"
		result.failure = createToolFailure({
			reason: "execution_failed",
			scopeKind: "operation",
			scopeIdentity: call.id,
			effectsStarted: "yes",
			outcome: "unknown",
			recovery: { kind: "verify-outcome" },
		})
		expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
	})

	it.each(["id", "name", "arguments"] as const)("refuses changed %s on a reserved call", (field) => {
		const input = settledRead()
		input.reservedToolCalls = [{ ...call, [field]: field === "arguments" ? { path: "other.ts" } : "other" }]
		expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
	})

	it("refuses a different result ID or name", () => {
		for (const field of ["callId", "name"] as const) {
			const input = settledRead()
			input.earlyReadDispatches[0]!.outcome!.results[0]![field] = "other"
			expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
		}
	})

	it("refuses malformed tool intent after a settled read", () => {
		const input = settledRead()
		input.response.items.push({ type: "error", callId: "pending", message: "Incomplete arguments" })
		expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
	})

	it("refuses a trailing unexecuted mutation and duplicate call IDs", () => {
		for (const extra of [call, { ...call, id: "write-2", name: "apply_patch" }]) {
			const input = settledRead()
			input.response = createAgentResponse([call, extra])
			expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
		}
	})

	it("requires every settled read to match its original position and call identity", () => {
		const input = settledRead()
		const second = { ...call, id: "read-2", arguments: { path: "src/b.ts" } }
		const dispatch = input.earlyReadDispatches[0]!
		input.response = createAgentResponse([call, second])
		input.reservedToolCalls = [call, second]
		input.earlyReadDispatches = [
			dispatch,
			{
				...dispatch,
				call: second,
				outcome: {
					status: "completed",
					results: [{ ...dispatch.outcome!.results[0]!, callId: second.id }],
				},
			},
		]
		expect(canContinueFromCommittedHistoryTools(input)).toBe(true)
		input.earlyReadDispatches = [...input.earlyReadDispatches].reverse()
		expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
	})

	it("rejects duplicate IDs even when every reservation and receipt agrees", () => {
		const input = settledRead()
		input.response = createAgentResponse([call, call])
		input.reservedToolCalls = [call, call]
		input.earlyReadDispatches = [input.earlyReadDispatches[0]!, input.earlyReadDispatches[0]!]
		expect(canContinueFromCommittedHistoryTools(input)).toBe(false)
	})
})
