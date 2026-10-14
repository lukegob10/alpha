import {
	legacySubagentSpawnAgentArgsSchema,
	subagentAgentTypesSchema,
	subagentModelRouteStateSchema,
	subagentSpawnAgentArgsSchema,
	subagentSpawnAgentV2ArgsSchema,
} from "../subagent.js"

describe("spawn_agent request contracts", () => {
	it("validates bounded named-agent definitions without embedding provider credentials", () => {
		expect(
			subagentAgentTypesSchema.parse({
				researcher: {
					description: "Inspect code paths",
					role: "explore",
					apiConfigId: "profile-id",
					model: "gpt-6-sol",
					reasoningEffort: "high",
					developerInstructions: "Cite source paths.",
				},
			}),
		).toMatchObject({ researcher: { role: "explore", apiConfigId: "profile-id" } })
		expect(subagentAgentTypesSchema.safeParse({ "Invalid Name": { description: "Invalid" } }).success).toBe(false)
		expect(
			subagentAgentTypesSchema.safeParse({ researcher: { description: "Valid", apiKey: "secret" } }).success,
		).toBe(false)
	})

	it("requires task_name and message while keeping V2 controls optional", () => {
		expect(
			subagentSpawnAgentV2ArgsSchema.parse({
				task_name: "backend_review",
				message: "Trace the task lifecycle.",
			}),
		).toEqual({
			task_name: "backend_review",
			message: "Trace the task lifecycle.",
		})

		expect(
			subagentSpawnAgentV2ArgsSchema.parse({
				task_name: "backend_review",
				message: "Trace the task lifecycle.",
				agent_type: "explorer",
				fork_turns: "3",
				model: "gpt-6-sol",
				reasoning_effort: "high",
			}),
		).toMatchObject({
			agent_type: "explorer",
			fork_turns: "3",
			model: "gpt-6-sol",
			reasoning_effort: "high",
		})
	})

	it.each([
		{},
		{ task_name: "backend_review" },
		{ message: "Trace the task lifecycle." },
		{ task_name: "Invalid-name", message: "Trace the task lifecycle." },
		{ task_name: "backend_review", message: " " },
	])("rejects incomplete or malformed V2 requests: %j", (args) => {
		expect(subagentSpawnAgentV2ArgsSchema.safeParse(args).success).toBe(false)
	})

	it.each([
		{ model: " " },
		{ model: "m".repeat(257) },
		{ reasoning_effort: "disable" },
		{ reasoning_effort: "ultra" },
		{ fork_turns: "0" },
		{ fork_turns: "01" },
		{ agent_type: "Invalid Name" },
		{ write_scope: ["src"] },
		{ fork_context: true },
	])("rejects invalid V2 overrides or legacy authority fields: %j", (overrides) => {
		expect(
			subagentSpawnAgentV2ArgsSchema.safeParse({
				task_name: "backend_review",
				message: "Trace the task lifecycle.",
				...overrides,
			}).success,
		).toBe(false)
	})

	it("keeps V2 role names as requests instead of granting a write scope", () => {
		const workerRequest = subagentSpawnAgentArgsSchema.parse({
			task_name: "scoped_worker",
			message: "Update the parser tests.",
			agent_type: "worker",
		})

		expect(workerRequest).toEqual({
			task_name: "scoped_worker",
			message: "Update the parser tests.",
			agent_type: "worker",
		})
		expect(workerRequest).not.toHaveProperty("write_scope")
		expect(
			subagentSpawnAgentV2ArgsSchema.parse({
				task_name: "research",
				message: "Investigate the issue",
				agent_type: "custom-researcher",
			}).agent_type,
		).toBe("custom-researcher")
	})

	it("reads the prior Alpha objective, role, scope, and deliverable fields", () => {
		expect(
			legacySubagentSpawnAgentArgsSchema.parse({
				task_name: "scoped_worker",
				fork_turns: "none",
				objective: "Update the parser tests.",
				agent_kind: "worker",
				write_scope: ["src/core/parser.spec.ts"],
				expected_output: ["Updated tests"],
			}),
		).toMatchObject({
			agent_kind: "worker",
			write_scope: ["src/core/parser.spec.ts"],
			expected_output: ["Updated tests"],
		})

		expect(
			legacySubagentSpawnAgentArgsSchema.parse({
				objective: "Inspect the parser.",
				agent_kind: "review",
				write_scope: null,
				expected_output: null,
			}),
		).toMatchObject({ objective: "Inspect the parser.", agent_kind: "review" })
	})

	it("still requires an explicit bounded scope for legacy Worker calls", () => {
		for (const args of [
			{ objective: "Update the parser.", agent_kind: "worker" },
			{ objective: "Update the parser.", agent_kind: "worker", write_scope: null },
			{ objective: "Update the parser.", agent_kind: "worker", write_scope: [] },
			{ objective: "Update the parser.", agent_kind: "worker", write_scope: ["src", ...Array(12).fill("docs")] },
		]) {
			expect(legacySubagentSpawnAgentArgsSchema.safeParse(args).success).toBe(false)
		}
	})

	it("reads legacy model routes and records explicit spawn override provenance", () => {
		const legacyRoute = {
			source: "parent" as const,
			resolution: "selected" as const,
			profileName: "Parent",
		}
		expect(subagentModelRouteStateSchema.parse(legacyRoute)).toEqual(legacyRoute)
		expect(
			subagentModelRouteStateSchema.parse({
				source: "spawn",
				resolution: "selected",
				profileName: "Parent",
				modelId: "requested-model",
				requestedModelId: "requested-model",
				requestedReasoningEffort: "xhigh",
			}),
		).toMatchObject({ source: "spawn", requestedModelId: "requested-model", requestedReasoningEffort: "xhigh" })
		expect(
			subagentModelRouteStateSchema.safeParse({
				...legacyRoute,
				requestedReasoningEffort: "ultra",
			}).success,
		).toBe(false)
	})
})
