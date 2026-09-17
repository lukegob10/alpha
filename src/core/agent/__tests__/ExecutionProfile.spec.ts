import type OpenAI from "openai"

import { applyExecutionProfile, resolveExecutionProfile } from "../ExecutionProfile"
import { createToolPolicySnapshot } from "../ToolPolicy"

const schemas = ["read_file", "execute_command", "apply_diff", "attempt_completion"].map(
	(name) =>
		({ type: "function", function: { name, parameters: { type: "object" } } }) as OpenAI.Chat.ChatCompletionTool,
)

const capabilities = {
	read_file: { concurrency: "parallel", sideEffects: "none", controlFlow: false, requiresApproval: false },
	execute_command: { concurrency: "barrier", sideEffects: "external", controlFlow: false, requiresApproval: true },
	apply_diff: { concurrency: "serial", sideEffects: "workspace", controlFlow: false, requiresApproval: true },
	attempt_completion: { concurrency: "barrier", sideEffects: "none", controlFlow: true, requiresApproval: false },
} as const

const policy = createToolPolicySnapshot({
	visibleTools: Object.keys(capabilities),
	capabilities,
	digest: "base",
})

describe("execution profiles", () => {
	it("maps legacy and custom modes compatibly", () => {
		expect(resolveExecutionProfile("code").id).toBe("work")
		expect(resolveExecutionProfile("architect").id).toBe("plan")
		expect(resolveExecutionProfile("custom-mode").id).toBe("work")
	})

	it("keeps Work's existing policy without widening it", () => {
		const result = applyExecutionProfile(resolveExecutionProfile("work"), policy, schemas)
		expect(result.allowedFunctionNames).toEqual(policy.allowedTools)
	})

	it("derives Plan schemas and policy from the same non-mutating snapshot", () => {
		const result = applyExecutionProfile(resolveExecutionProfile("plan"), policy, schemas)
		expect(result.allowedFunctionNames).toEqual(["read_file"])
		expect(result.schemas.map((schema) => schema.type === "function" && schema.function.name)).toEqual([
			"read_file",
		])
		expect(result.policy.allowedTools).toEqual(["read_file"])
	})
})
