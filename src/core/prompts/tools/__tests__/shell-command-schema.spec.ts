import { describe, expect, it } from "vitest"

import { createExecuteCommandTool } from "../native-tools/execute_command"
import manageCommand from "../native-tools/manage_command"

type ObjectSchema = {
	type?: string | string[]
	properties?: Record<string, { type?: string | string[] }>
	required?: string[]
	additionalProperties?: boolean
}

function definitionOf(planMode = false) {
	const tool = createExecuteCommandTool(planMode)
	if (tool.type !== "function") throw new Error("shell schema must be a function tool")
	return tool.function
}

function parametersOf(planMode = false): ObjectSchema {
	return definitionOf(planMode).parameters as ObjectSchema
}

describe("shell command schema", () => {
	it("publishes shell with only command required and optional host fields", () => {
		const tool = definitionOf()
		const parameters = parametersOf()

		expect(tool.name).toBe("shell")
		expect(tool.strict).toBe(false)
		expect(parameters.required).toEqual(["command"])
		expect(parameters.properties).toMatchObject({
			command: { type: "string" },
			cwd: { type: "string" },
			timeout: { type: "number" },
		})
		expect(parameters.properties).not.toHaveProperty("verification")
		expect(parameters.additionalProperties).toBe(false)
	})

	it("keeps the Plan allow-list contract in the shell description", () => {
		const tool = definitionOf(true)
		const parameters = parametersOf(true)

		expect(tool.name).toBe("shell")
		expect(tool.description).toContain("strict Plan mode")
		expect(parameters.required).toEqual(["command"])
		expect(parameters.properties).not.toHaveProperty("verification")
	})

	it("folds artifact reads into the optional manage command contract", () => {
		if (manageCommand.type !== "function") throw new Error("manage command schema must be a function tool")
		const parameters = manageCommand.function.parameters as ObjectSchema

		expect(manageCommand.function.name).toBe("manage_command")
		expect(manageCommand.function.strict).toBe(false)
		expect(parameters.required).toEqual(["action"])
		expect(parameters.properties?.action).toMatchObject({ type: "string" })
		expect((parameters.properties?.action as { enum?: string[] }).enum).toEqual(["wait", "stop", "input", "read"])
		expect(parameters.properties).toMatchObject({
			execution_id: { type: "string" },
			artifact_id: { type: "string" },
			search: { type: "string" },
			offset: { type: "integer" },
			limit: { type: "integer" },
		})
		expect(parameters.additionalProperties).toBe(false)
	})
})
