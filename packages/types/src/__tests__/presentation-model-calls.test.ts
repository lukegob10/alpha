import { describe, expect, it } from "vitest"

import { historyItemSchema } from "../history.js"
import { ackSchema, TaskCommandName, taskCommandSchema } from "../ipc.js"

const history = { id: "task", number: 1, ts: 1, task: "Task objective", tokensIn: 0, tokensOut: 0, totalCost: 0 }
const startTask = {
	commandName: TaskCommandName.StartNewTask,
	data: { configuration: { apiProvider: "vertex" }, text: "Task objective" },
}

describe("host-owned presentation model-call opt-out", () => {
	describe("persisted history", () => {
		it("keeps legacy history interactive without inventing a preference", () => {
			expect(historyItemSchema.parse(history)).toEqual(history)
		})

		it("retains explicit suppression through a JSON history round-trip", () => {
			const suppressed = { ...history, presentationModelCalls: false }

			expect(historyItemSchema.parse(JSON.parse(JSON.stringify(suppressed)))).toEqual(suppressed)
		})

		it.each([true, null, "false", 0])(
			"rejects a history preference that is not an explicit opt-out: %j",
			(value) => {
				expect(historyItemSchema.safeParse({ ...history, presentationModelCalls: value }).success).toBe(false)
			},
		)
	})

	describe("task creation wire contract", () => {
		it("keeps old start commands unchanged when the preference is omitted", () => {
			expect(taskCommandSchema.parse(startTask)).toEqual(startTask)
		})

		it("retains suppression outside provider configuration", () => {
			const command = { ...startTask, data: { ...startTask.data, presentationModelCalls: false } }

			expect(taskCommandSchema.parse(command)).toEqual(command)
		})

		it.each([true, null, "false", 0])("rejects a start preference that is not an explicit opt-out: %j", (value) => {
			expect(
				taskCommandSchema.safeParse({
					...startTask,
					data: { ...startTask.data, presentationModelCalls: value },
				}).success,
			).toBe(false)
		})
	})

	describe("capability acknowledgement", () => {
		const acknowledgement = {
			clientId: "client",
			pid: 101,
			ppid: 100,
			capabilities: { targetedTaskCancellation: true },
		}

		it("keeps the previous handshake valid without inventing opt-out support", () => {
			expect(ackSchema.parse(acknowledgement)).toEqual(acknowledgement)
		})

		it.each([false, true])("preserves explicit presentation opt-out support %s", (supported) => {
			const ack = {
				...acknowledgement,
				capabilities: { ...acknowledgement.capabilities, presentationModelCallOptOut: supported },
			}

			expect(ackSchema.parse(ack)).toEqual(ack)
		})

		it.each([null, "true", 1])("rejects malformed presentation opt-out support %j", (supported) => {
			expect(
				ackSchema.safeParse({
					...acknowledgement,
					capabilities: { presentationModelCallOptOut: supported },
				}).success,
			).toBe(false)
		})
	})
})
