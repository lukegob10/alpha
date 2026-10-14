import { describe, expect, it } from "vitest"

import { getNativeTools } from ".."
import { getToolCapabilities } from "../../../../tools/ToolRegistry"

const orchestrationNames = ["create_task", "list_tasks", "wait_task", "send_task_message", "steer_task", "stop_task"]

function namesFor(role: "root" | "child" | "none", includeCreateTaskSchema = false) {
	return getNativeTools({ crossTaskRole: role, includeCreateTaskSchema })
		.filter((tool) => tool.type === "function" && orchestrationNames.includes(tool.function.name))
		.map((tool) => (tool.type === "function" ? tool.function.name : ""))
}

describe("cross-task orchestration tool surface", () => {
	it("offers creation only on a directly requested root surface and messaging only to its child", () => {
		expect(namesFor("root")).toEqual(orchestrationNames.filter((name) => name !== "create_task"))
		expect(namesFor("root", true)).toEqual(orchestrationNames)
		expect(namesFor("child")).toEqual(["send_task_message"])
		expect(namesFor("child", true)).toEqual(["send_task_message"])
		expect(namesFor("none")).toEqual([])
	})

	it("uses strict schemas with bounded task IDs and objectives", () => {
		const tools = getNativeTools({ crossTaskRole: "root", includeCreateTaskSchema: true }).filter(
			(tool) => tool.type === "function" && orchestrationNames.includes(tool.function.name),
		)
		expect(tools).toHaveLength(orchestrationNames.length)
		for (const tool of tools) {
			if (tool.type !== "function") continue
			expect(tool.function.strict).toBe(true)
			expect(tool.function.parameters).toMatchObject({ type: "object", additionalProperties: false })
		}
		const create = tools.find((tool) => tool.type === "function" && tool.function.name === "create_task")
		expect(create).toMatchObject({
			function: {
				parameters: {
					required: ["objective", "workspace_mode"],
					properties: { objective: { minLength: 1, maxLength: 12_000 } },
				},
			},
		})
	})

	it("keeps effects serialized and approval-gates every mutation", () => {
		for (const name of ["create_task", "send_task_message", "steer_task", "stop_task"]) {
			expect(getToolCapabilities(name)).toMatchObject({
				concurrency: "barrier",
				sideEffects: "task",
				controlFlow: true,
				requiresApproval: true,
			})
		}
		for (const name of ["list_tasks", "wait_task"]) {
			expect(getToolCapabilities(name)).toMatchObject({
				concurrency: name === "wait_task" ? "barrier" : "serial",
				requiresApproval: false,
			})
		}
	})
})
