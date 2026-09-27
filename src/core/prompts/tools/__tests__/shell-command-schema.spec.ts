import { describe, expect, it } from "vitest"

import { getExecCommandYieldTimeBounds } from "../../../tools/commandTimeouts"
import { createExecCommandTool } from "../native-tools/execute_command"
import manageCommand, { createWriteStdinTool } from "../native-tools/manage_command"

type ObjectSchema = {
	type?: string | string[]
	properties?: Record<string, { type?: string | string[]; minimum?: number; maximum?: number; description?: string }>
	required?: string[]
	additionalProperties?: boolean
}

function definitionOf(planMode = false) {
	const tool = createExecCommandTool(planMode)
	if (tool.type !== "function") throw new Error("exec_command schema must be a function tool")
	return tool.function
}

function parametersOf(planMode = false): ObjectSchema {
	return definitionOf(planMode).parameters as ObjectSchema
}

describe("command tool schemas", () => {
	it("publishes exec_command with cmd required and optional supported fields", () => {
		const tool = definitionOf()
		const parameters = parametersOf()

		expect(tool.name).toBe("exec_command")
		expect(tool.strict).toBe(false)
		expect(parameters.required).toEqual(["cmd"])
		expect(parameters.properties).toMatchObject({
			cmd: { type: "string" },
			workdir: { type: "string" },
			yield_time_ms: { type: "integer" },
			max_output_tokens: { type: "integer" },
		})
		expect(parameters.properties?.yield_time_ms).toMatchObject({
			minimum: getExecCommandYieldTimeBounds().minimum,
			maximum: getExecCommandYieldTimeBounds().maximum,
		})
		expect(parameters.properties?.yield_time_ms?.description).toContain("Defaults to 10000 ms")
		expect(parameters.properties?.yield_time_ms?.description).toContain(
			process.platform === "win32"
				? "effective range on Windows is 10000-30000 ms"
				: "effective range is 250-30000 ms",
		)
		expect(parameters.properties).not.toHaveProperty("tty")
		expect(parameters.properties).not.toHaveProperty("shell")
		expect(parameters.properties).not.toHaveProperty("login")
		expect(parameters.properties).not.toHaveProperty("verification")
		expect(parameters.additionalProperties).toBe(false)
	})

	it("keeps the Plan allow-list contract in the exec_command description", () => {
		const tool = definitionOf(true)
		const parameters = parametersOf(true)

		expect(tool.name).toBe("exec_command")
		expect(tool.description).toContain("strict Plan mode")
		expect(parameters.required).toEqual(["cmd"])
		expect(parameters.properties).not.toHaveProperty("verification")
	})

	it("publishes write_stdin with task session identifiers and bounded controls", () => {
		const writeStdin = createWriteStdinTool()
		if (writeStdin.type !== "function") throw new Error("write_stdin schema must be a function tool")
		const parameters = writeStdin.function.parameters as ObjectSchema

		expect(writeStdin.function.name).toBe("write_stdin")
		expect(parameters.required).toEqual(["session_id"])
		expect(parameters.properties).toMatchObject({
			session_id: { type: "integer" },
			chars: { type: "string" },
			yield_time_ms: { type: "integer" },
			max_output_tokens: { type: "integer" },
		})
		expect(parameters.additionalProperties).toBe(false)
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
