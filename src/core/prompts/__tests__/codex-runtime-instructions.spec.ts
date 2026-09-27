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

const gpt6ModelPrompts = ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"] as const
const pinnedSourceSha256 = {
	defaultCollaboration: "c1ed5ce0a3a49ba35b9eeba9774e0bd8ebd10eddec13b2dac564e7170513356c",
	multiAgentRootRole: "4c86e7411c24afc557c906f31a267c991568311715cc81ba0129604c70b83755",
	multiAgentSubagentRole: "3651a6dee0715ee4990f23bfbc35a13c5da42e24f35a9eda2809614fd3b0a87b",
} as const

describe("pinned Codex runtime instructions", () => {
	it("records the upstream source provenance", () => {
		expect(CODEX_RUNTIME_PROMPT_SOURCE_COMMIT).toBe("dfdb40cd0b72dfba3293db5c7c441232e8ef1a60")
		expect(CODEX_RUNTIME_PROMPT_SOURCE_PATH).toBe("codex-rs/models-manager/models.json")
		expect(CODEX_RUNTIME_PROMPT_SOURCE_RETRIEVED_AT).toBe("2026-09-26")
	})

	it.each(gpt6ModelPrompts)("selects the pinned default collaboration mode for %s", (modelPromptSlug) => {
		const result = resolveCodexRuntimeInstructions(modelPromptSlug, "default")
		const instructions = result.collaborationModeInstructions ?? ""

		expect(instructions).toContain("# Collaboration Mode: Default")
		expect(createHash("sha256").update(instructions, "utf8").digest("hex")).toBe(
			pinnedSourceSha256.defaultCollaboration,
		)
		expect(CODEX_RUNTIME_PROMPT_SHA256.defaultCollaboration).toBe(pinnedSourceSha256.defaultCollaboration)
		expect(result.collaborationModeInstructions?.toLowerCase()).not.toContain("sandbox")
	})

	it("has no upstream Plan or multi-agent mode template", () => {
		expect(CODEX_PLAN_COLLABORATION_MODE).toBeNull()
		expect(CODEX_MULTI_AGENT_MODE).toBeNull()
		const result = resolveCodexRuntimeInstructions("gpt-6-sol", "plan", "root")

		expect(result.collaborationModeInstructions).toBeUndefined()
		expect(result.multiAgentRoleInstructions).toBeDefined()
	})

	it.each([
		["root", pinnedSourceSha256.multiAgentRootRole],
		["subagent", pinnedSourceSha256.multiAgentSubagentRole],
	] as const)("selects the exact pinned multi-agent %s role", (role, digest) => {
		const result = resolveCodexRuntimeInstructions("gpt-6-sol", "default", role)
		const instructions = result.multiAgentRoleInstructions ?? ""

		expect(instructions).not.toBe("")
		expect(createHash("sha256").update(instructions, "utf8").digest("hex")).toBe(digest)
		expect(CODEX_RUNTIME_PROMPT_SHA256[role === "root" ? "multiAgentRootRole" : "multiAgentSubagentRole"]).toBe(
			digest,
		)
	})

	it("does not apply GPT-6 runtime fields to catalog variants with null messages", () => {
		expect(resolveCodexRuntimeInstructions("gpt-5.6", "default", "root")).toEqual({
			collaborationMode: "default",
			multiAgentRole: "root",
		})
	})
})
