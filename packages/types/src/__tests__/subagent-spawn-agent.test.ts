import {
	legacySubagentSpawnAgentArgsSchema,
	strictSubagentModelRouteStateSchema,
	subagentAgentTypesSchema,
	subagentModelRouteStateSchema,
	subagentSpawnAgentArgsSchema,
	subagentSpawnAgentV2ArgsSchema,
} from "../subagent.js"

describe("spawn_agent request contracts", () => {
	it.each([
		[" NONE ", "none"],
		[" All ", "all"],
		["\t", "all"],
		[" 3 ", "all"],
		["01", "all"],
		["+2", "all"],
		["18446744073709551615", "all"],
	])("normalizes V2 fork selection %j to %j", (fork_turns, expected) => {
		expect(
			subagentSpawnAgentV2ArgsSchema.parse({
				task_name: "review",
				message: "Review the parser.",
				fork_turns,
			}).fork_turns,
		).toBe(expected)
	})

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
				provider: "openai-native",
				profile: "Saved OpenAI",
				model: "gpt-6-sol",
				reasoning_effort: "high",
			}),
		).toMatchObject({
			agent_type: "explorer",
			fork_turns: "all",
			provider: "openai-native",
			profile: "Saved OpenAI",
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
		{ provider: "OpenAI" },
		{ provider: "fake-ai" },
		{ profile: " " },
		{ model: " " },
		{ model: "m".repeat(257) },
		{ reasoning_effort: "disable" },
		{ reasoning_effort: "unsupported" },
		{ fork_turns: "0" },
		{ fork_turns: "+0" },
		{ fork_turns: "-1" },
		{ fork_turns: "18446744073709551616" },
		{ fork_turns: "1".repeat(100) },
		{ fork_turns: "0".repeat(128) + "1" },
		{ agent_type: "Invalid Name" },
		{ write_scope: ["src"] },
		{ fork_context: true },
		{ apiKey: "secret" },
		{ unboundProfile: true },
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
				requestedReasoningEffort: "unsupported",
			}).success,
		).toBe(false)
	})

	it("retains frozen effective reasoning independently from the requested effort", () => {
		const legacyRoute = { source: "parent", resolution: "selected", profileName: "Parent" }
		for (const schema of [subagentModelRouteStateSchema, strictSubagentModelRouteStateSchema]) {
			expect(schema.parse(legacyRoute)).not.toHaveProperty("effectiveReasoning")
			for (const effectiveReasoning of [
				{ kind: "effort", effort: "high" },
				{ kind: "off" },
				{ kind: "on" },
				{ kind: "default" },
				{ kind: "custom", value: "adaptive" },
			]) {
				const route = { ...legacyRoute, requestedReasoningEffort: "medium", effectiveReasoning }
				expect(schema.parse(JSON.parse(JSON.stringify(route)))).toEqual(route)
			}
			for (const effectiveReasoning of [
				{ kind: "effort", effort: "disable" },
				{ kind: "custom", value: "unsafe value" },
				{ kind: "unknown" },
			]) {
				expect(schema.safeParse({ ...legacyRoute, effectiveReasoning }).success).toBe(false)
			}
		}
	})

	it.each([
		{},
		{ enableReasoningEffort: true, reasoningEffort: "high" },
		{ enableReasoningEffort: false, reasoningEffort: "disable" },
	])(
		"round-trips captured reasoning configuration independently of requested effort: %j",
		(reasoningConfiguration) => {
			const route = {
				source: "parent",
				resolution: "selected",
				profileName: "Parent",
				reasoningConfiguration,
			}
			expect(subagentModelRouteStateSchema.parse(JSON.parse(JSON.stringify(route)))).toEqual(route)
			expect(subagentModelRouteStateSchema.parse(route)).not.toHaveProperty("requestedReasoningEffort")
		},
	)

	it.each([
		{ enableReasoningEffort: "false" },
		{ reasoningEffort: "unsupported" },
		{ apiKey: "secret" },
		{ endpoint: "https://example.com" },
	])("rejects malformed or credential-bearing reasoning configuration: %j", (reasoningConfiguration) => {
		expect(
			subagentModelRouteStateSchema.safeParse({
				source: "parent",
				resolution: "selected",
				profileName: "Parent",
				reasoningConfiguration,
			}).success,
		).toBe(false)
	})

	it("round-trips a route with no truthful saved profile binding", () => {
		const route = {
			source: "parent",
			resolution: "selected",
			profileName: "Injected configuration",
			unboundProfile: true,
		}
		expect(subagentModelRouteStateSchema.parse(JSON.parse(JSON.stringify(route)))).toEqual(route)
	})

	it.each([
		{ unboundProfile: false },
		{ unboundProfile: true, profileId: "saved-profile" },
		{ unboundProfile: true, profileId: "" },
	])("rejects malformed or contradictory profile bindings: %j", (binding) => {
		for (const schema of [subagentModelRouteStateSchema, strictSubagentModelRouteStateSchema]) {
			expect(
				schema.safeParse({
					source: "parent",
					resolution: "selected",
					profileName: "Injected configuration",
					...binding,
				}).success,
			).toBe(false)
		}
	})

	it("keeps compatibility readers credential-free and context routes strict", () => {
		const routeWithSecret = {
			source: "parent",
			resolution: "selected",
			profileName: "Injected configuration",
			unboundProfile: true,
			apiKey: "secret",
		}
		expect(subagentModelRouteStateSchema.parse(routeWithSecret)).not.toHaveProperty("apiKey")
		expect(strictSubagentModelRouteStateSchema.safeParse(routeWithSecret).success).toBe(false)
	})
})
