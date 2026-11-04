import { Task } from "../Task"
import type { AgentTurnContinuationDiagnostic } from "../../agent/AgentTurnEngine"

function fixture() {
	const append = vi.fn().mockResolvedValue(undefined)
	const task = Object.assign(Object.create(Task.prototype), {
		modelContinuationReceipts: [],
		modelContinuationsTruncated: false,
		agentTurnId: "turn",
		appendAgentTurnEvent: append,
	}) as Task
	return { task, append }
}

describe("Task continuation diagnostics", () => {
	it("records the shared engine reason in the existing event log with turn identity", () => {
		const { task, append } = fixture()
		const reason: AgentTurnContinuationDiagnostic = { step: 2, reason: "host-pending-input" }
		task["recordModelContinuation"](reason)
		expect(append).toHaveBeenCalledExactlyOnceWith({ type: "model_continuation", ...reason }, undefined, {
			turnId: "turn",
		})
		expect(task.getModelContinuationDiagnostics()).toEqual({
			receipts: [{ ...reason, turnId: "turn" }],
			truncated: false,
		})
	})

	it("bounds the cached projection and protects it from callers", () => {
		const { task } = fixture()
		for (let step = 2; step <= 40; step++) task["recordModelContinuation"]({ step, reason: "model-tool-call" })
		const exported = task.getModelContinuationDiagnostics()
		expect(exported.receipts).toHaveLength(32)
		expect(exported.receipts[0].step).toBe(9)
		expect(exported.truncated).toBe(true)
		exported.receipts[0].step = 999
		exported.receipts.pop()
		expect(task.getModelContinuationDiagnostics().receipts).toHaveLength(32)
		expect(task.getModelContinuationDiagnostics().receipts[0].step).toBe(9)
	})
})
