import { describe, expect, it } from "vitest"

import { createSpawnAgentTool } from "../spawn_agent"

describe("spawn_agent native tool", () => {
	it("leaves role selection to the host unless the user requested an override", () => {
		const codeTool = createSpawnAgentTool()
		const planTool = createSpawnAgentTool(["explore", "review"])

		expect(codeTool.function.parameters.required).toEqual(["task_name", "message"])
		expect(codeTool.function.description).toContain("omit agent_type")
		expect(codeTool.function.parameters.properties.agent_type.description).toContain(
			"Omit unless the user explicitly requests a role",
		)
		expect(codeTool.function.parameters.properties.agent_type.description).toContain("worker")
		expect(planTool.function.description).toContain("omit agent_type")
		expect(planTool.function.parameters.properties.agent_type.description).not.toContain("worker")
	})
})
