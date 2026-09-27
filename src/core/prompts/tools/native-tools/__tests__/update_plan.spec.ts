import { describe, expect, it } from "vitest"

import { toOpenAiStrictToolSchema } from "../../../../../api/transform/openai-strict-tool-schema"
import { getNativeTools } from ".."
import updatePlan from "../update_plan"

describe("update_plan native tool", () => {
	it("matches the full-plan replacement contract", () => {
		const parameters = updatePlan.function.parameters
		const properties = parameters.properties as Record<string, any>

		expect(updatePlan.function.name).toBe("update_plan")
		expect(updatePlan.function.strict).toBe(false)
		expect(updatePlan.function.description).toContain("At most one step may be in_progress")
		expect(parameters.required).toEqual(["plan"])
		expect(properties.explanation.type).toBe("string")
		expect(properties.plan.items.required).toEqual(["step", "status"])
		expect(properties.plan.items.properties.status.enum).toEqual(["pending", "in_progress", "completed"])
		expect(parameters.additionalProperties).toBe(false)
	})

	it("keeps the same optional-explanation action in Code and Plan for the primary task", () => {
		for (const planMode of [false, true]) {
			const tools = getNativeTools({ planMode })
			const planTools = tools.filter((tool) => tool.type === "function" && tool.function.name === "update_plan")
			expect(planTools).toHaveLength(1)
			expect(planTools[0]).toMatchObject({
				function: { strict: false, parameters: { required: ["plan"] } },
			})
		}
		const childTools = getNativeTools({ taskKind: "subagent" })
		expect(childTools.some((tool) => tool.type === "function" && tool.function.name === "update_plan")).toBe(false)
	})

	it("keeps explanation optional while producing a valid strict schema", () => {
		const strict = toOpenAiStrictToolSchema(updatePlan.function.parameters) as {
			required: string[]
			properties: { explanation: { type: unknown } }
		}

		expect(strict.required).toEqual(["explanation", "plan"])
		expect(strict.properties.explanation.type).toEqual(["string", "null"])
	})
})
