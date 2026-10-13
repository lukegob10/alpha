import { createHash } from "node:crypto"

import { describe, expect, it } from "vitest"

import {
	CODEX_RUNTIME_PROMPT_SHA256,
	CODEX_RUNTIME_PROMPT_SOURCE_COMMIT,
	CODEX_RUNTIME_PROMPT_SOURCE_PATH,
	CODEX_RUNTIME_PROMPT_SOURCE_RETRIEVED_AT,
	CODEX_MULTI_AGENT_MODE,
	CODEX_PLAN_COLLABORATION_MODE,
	resolveCodexRuntimeInstructions,
} from "../codex-runtime-instructions"

const gpt6ModelPrompts = ["gpt-6-astra", "gpt-6.1-sol", "gpt-6-sol", "gpt-6-luna"] as const
const defaultCollaborationSha256 = "c1ed5ce0a3a49ba35b9eeba9774e0bd8ebd10eddec13b2dac564e7170513356c"

describe("pinned Codex runtime instructions", () => {
	it("records the upstream source provenance", () => {
		expect(CODEX_RUNTIME_PROMPT_SOURCE_COMMIT).toBe("4994306e9f80448bde85e770a0b0c93d3fee5665")
		expect(CODEX_RUNTIME_PROMPT_SOURCE_PATH).toBe("codex-rs/models-manager/models.json")
		expect(CODEX_RUNTIME_PROMPT_SOURCE_RETRIEVED_AT).toBe("2026-09-29")
	})

	it.each(gpt6ModelPrompts)("selects the pinned default collaboration mode for %s", (modelPromptSlug) => {
		const result = resolveCodexRuntimeInstructions(modelPromptSlug, "default")
		const instructions = result.collaborationModeInstructions ?? ""

		expect(instructions).toContain("# Collaboration Mode: Default")
		expect(createHash("sha256").update(instructions, "utf8").digest("hex")).toBe(defaultCollaborationSha256)
		expect(CODEX_RUNTIME_PROMPT_SHA256.defaultCollaboration).toBe(defaultCollaborationSha256)
		expect(result.collaborationModeInstructions?.toLowerCase()).not.toContain("sandbox")
	})

	it("has no upstream Plan or multi-agent mode template", () => {
		expect(CODEX_PLAN_COLLABORATION_MODE).toBeNull()
		expect(CODEX_MULTI_AGENT_MODE).toBeNull()
		const result = resolveCodexRuntimeInstructions("gpt-6-sol", "plan", "root")

		expect(result.collaborationModeInstructions).toBeUndefined()
		expect(result.multiAgentRoleInstructions).toBeDefined()
	})

	it.each(["root", "subagent"] as const)(
		"describes Alpha's managed communication contract for the %s role",
		(role) => {
			const result = resolveCodexRuntimeInstructions("gpt-6-sol", "default", role)
			const instructions = result.multiAgentRoleInstructions ?? ""

			expect(instructions).not.toBe("")
			expect(instructions).toContain("agent-origin input at the next safe model-step boundary")
			expect(instructions).toContain("wait_agent observes mailbox activity")
			expect(instructions).toContain("does not own result delivery")
			expect(instructions).toContain("Late passive mail never restarts a stopped agent")
			expect(instructions).toContain("captured tool and policy surface")
			expect(instructions).not.toContain("immediately delivered")
			expect(instructions).not.toContain("same set of tools")
			expect(instructions).not.toContain("Message Type:")
			expect(instructions).not.toContain("analysis channel")
		},
	)

	it("does not apply GPT-6 runtime fields to catalog variants with null messages", () => {
		expect(resolveCodexRuntimeInstructions("gpt-5.6", "default", "root")).toEqual({
			collaborationMode: "default",
			multiAgentRole: "root",
		})
	})
})
