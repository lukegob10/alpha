import type OpenAI from "openai"

import { applyExecutionProfile, resolveExecutionProfile } from "../ExecutionProfile"
import { createToolPolicySnapshot } from "../ToolPolicy"

const schemas = ["read_file", "exec_command", "apply_diff", "attempt_completion"].map(
	(name) =>
		({ type: "function", function: { name, parameters: { type: "object" } } }) as OpenAI.Chat.ChatCompletionTool,
)

const capabilities = {
	read_file: { concurrency: "parallel", sideEffects: "none", controlFlow: false, requiresApproval: false },
	exec_command: { concurrency: "barrier", sideEffects: "external", controlFlow: false, requiresApproval: true },
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
		expect(result.allowedFunctionNames).toEqual(["exec_command", "read_file"])
		expect(result.schemas.map((schema) => schema.type === "function" && schema.function.name)).toEqual([
			"read_file",
			"exec_command",
		])
		expect(result.policy.allowedTools).toEqual(["exec_command", "read_file"])
	})

	it("keeps host-restricted Plan questions, command reads, and agent controls callable", () => {
		const names = [
			"read_file",
			"exec_command",
			"request_user_input",
			"update_plan",
			"spawn_agent",
			"list_agents",
			"wait_agent",
			"send_message",
			"followup_task",
			"interrupt_agent",
			"apply_diff",
		]
		const planPolicy = createToolPolicySnapshot({
			visibleTools: names,
			capabilities: Object.fromEntries(
				names.map((name) => [
					name,
					{
						concurrency: "serial" as const,
						sideEffects:
							name === "exec_command" || name === "apply_diff"
								? ("workspace" as const)
								: name === "read_file"
									? ("none" as const)
									: ("task" as const),
						controlFlow: name === "request_user_input" || name === "wait_agent",
						requiresApproval: true,
					},
				]),
			),
		})
		const planSchemas = names.map(
			(name) =>
				({
					type: "function",
					function: { name, parameters: { type: "object" } },
				}) as OpenAI.Chat.ChatCompletionTool,
		)
		const result = applyExecutionProfile(resolveExecutionProfile("architect"), planPolicy, planSchemas)
		expect(result.allowedFunctionNames).toEqual(names.filter((name) => name !== "apply_diff").sort())
		expect(result.schemas.map((schema) => schema.type === "function" && schema.function.name)).toEqual(
			names.filter((name) => name !== "apply_diff"),
		)
	})
})
