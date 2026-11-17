import type * as vscode from "vscode"
import { Tiktoken } from "tiktoken/lite"
import o200kBase from "tiktoken/encoders/o200k_base"
import { SYSTEM_PROMPT_FRAGMENTS, renderSystemPromptFragments } from "../system"
import { resolveCodexModelPrompt } from "../codex-model-instructions"
import { getAcceptanceSection } from "../sections/acceptance"
import type { SystemPromptSettings } from "../types"
import "../../../utils/path"

vi.mock("../sections/system-info", () => ({ getSystemInfoSection: () => "SYSTEM INFORMATION" }))

async function acceptancePrompt(
	settings: Partial<SystemPromptSettings> = {},
	mode: "code" | "architect" = "code",
	model = "gpt-6.1-sol",
	guidance?: string,
) {
	return SYSTEM_PROMPT_FRAGMENTS(
		{} as vscode.ExtensionContext,
		process.cwd(),
		false,
		undefined,
		undefined,
		mode,
		undefined,
		undefined,
		guidance,
		{},
		undefined,
		undefined,
		{ todoListEnabled: false, useAgentRules: false, newTaskRequireTodos: false, ...settings },
		undefined,
		model,
	)
}

describe("shared implementation acceptance guidance", () => {
	it.each(["gpt-5.4", "gpt-5.5"])(
		"gives user coding conventions precedence over %s style defaults",
		async (model) => {
			const rule = "Do not add comments to source code."
			const fragments = await acceptancePrompt({}, "code", model, rule)
			const base = fragments.instructionParts.find(({ origin }) => origin === "codex-model-instructions")
			const overlay = fragments.instructionParts.find(({ origin }) => origin === "alpha-feature-overlay")

			expect(base?.content).toContain("succinct code comments")
			expect(overlay).toMatchObject({
				role: "developer",
				content: expect.stringContaining(
					"User and project coding conventions override built-in style defaults.",
				),
			})
			expect(fragments.instructionParts).toContainEqual(
				expect.objectContaining({
					role: "user",
					origin: "global-custom-instructions",
					content: expect.stringContaining(rule),
				}),
			)
		},
	)

	it.each(["gpt-6.1-sol", "claude-sonnet-4-5"])(
		"prepares substantial implementation without AGENTS.md for %s while retaining the model base",
		async (model) => {
			const fragments = await acceptancePrompt({}, "code", model)
			const prompt = renderSystemPromptFragments(fragments)
			expect(prompt).toContain("ACCEPTANCE OF IMPLEMENTED WORK")
			expect(prompt).toContain("Before substantial implementation, identify the intended behavior")
			expect(prompt).toContain("intended behavior, important constraints, and how success will be checked")
			expect(prompt).toContain(
				"Reuse requirements already clear in the conversation or task context; resolve only material gaps within the requested scope",
			)
			expect(prompt).toContain("in existing task context; no separate document or agent is required")
			expect(prompt).toContain(
				"Before reporting an implementation complete, consider whether the checks could pass while the requested behavior is wrong.",
			)
			expect(prompt).toContain("requirement, check, observed result, and remaining gap")
			expect(prompt).toContain("mocks, excluded state, and unexercised supported conditions")
			expect(prompt).toContain("Trivial edits need no extra review or acceptance paperwork.")
			expect(fragments.instructionParts[0]?.content).toBe(resolveCodexModelPrompt(model).instructions)
			expect(fragments.instructionParts.map(({ content }) => content).join("")).toBe(prompt)
		},
	)

	it("guides the model to answer directly when the conversation is sufficient", async () => {
		const prompt = renderSystemPromptFragments(await acceptancePrompt({}, "code", "copilot/gpt-5.6-sol"))
		expect(prompt).toContain(
			"For questions that only request an answer, respond directly when the conversation provides enough evidence.",
		)
		expect(prompt).toContain("Gather missing evidence as needed.")
		expect(prompt).not.toContain("Before claiming completion, ask")
	})

	it("keeps combined acceptance with the parent and checks the integrated workspace", async () => {
		const prompt = renderSystemPromptFragments(await acceptancePrompt())
		expect(prompt).toContain("parent goal, shared constraints, and dependency contracts")
		expect(prompt).toContain("combined user workflow in the final integrated workspace")
		expect(prompt).toContain(
			"For implementation, reuse relevant results while their code, inputs, and environment remain valid",
		)
		expect(prompt).toContain("Correct confirmed failures and rerun the failed and affected checks")
	})

	it("keeps independent review conditional, fresh, and within the existing delegation policy", async () => {
		const prompt = renderSystemPromptFragments(
			await acceptancePrompt({ subagentDelegationPolicy: "explicit-only" }),
		)
		expect(prompt).toContain("material coverage uncertainty remains")
		expect(prompt).toContain("only when delegation is authorized and available")
		expect(prompt).toContain('fork_turns="none"')
		expect(prompt).toContain("rather than the builder's reasoning")
		expect(prompt).toContain("Do not repeat a clean review or launch a reviewer for each ticket")
		expect(prompt).toContain("Alpha managed delegation is explicit-only")
	})

	it("gives workers scoped acceptance without asking them to verify every ticket or spawn reviewers", async () => {
		const prompt = renderSystemPromptFragments(
			await acceptancePrompt({
				subagentRole: "worker",
				subagentUsesFrozenContext: true,
				subagentFrozenInstructions: "Project acceptance: preserve external edits.",
			}),
		)
		expect(prompt).toContain("Verify your assigned outcomes and dependency contracts")
		expect(prompt).toContain("Return the checks, observed results, and gaps to the parent")
		expect(prompt).toContain("Project acceptance: preserve external edits.")
		expect(prompt).toContain("Before substantial implementation, identify the intended behavior")
		expect(prompt).toContain("Reuse requirements already clear in the conversation or task context")
		expect(prompt).not.toContain('fork_turns="none"')
	})

	it.each(["explore", "review"] as const)(
		"does not ask read-only %s children to implement corrections",
		async (role) => {
			const prompt = renderSystemPromptFragments(await acceptancePrompt({ subagentRole: role }))
			expect(prompt).not.toContain("Correct confirmed failures")
			expect(prompt).not.toContain('fork_turns="none"')
		},
	)

	it("keeps Plan read-only and incorporates supplied project guidance", async () => {
		const fragments = await acceptancePrompt(
			{},
			"architect",
			"gpt-6.1-sol",
			"Project check: run the focused suite.",
		)
		expect(renderSystemPromptFragments(fragments)).not.toContain("ACCEPTANCE OF IMPLEMENTED WORK")
		expect(fragments.userContext).toContain("Project check: run the focused suite.")
	})

	it("bounds the extra shared prompt cost", async () => {
		const fragments = await acceptancePrompt()
		const overlay = fragments.instructionParts.find(({ origin }) => origin === "alpha-feature-overlay")!.content
		const acceptance = getAcceptanceSection(false)
		expect(overlay.split(acceptance)).toHaveLength(2)
		const encoder = new Tiktoken(o200kBase.bpe_ranks, o200kBase.special_tokens, o200kBase.pat_str)
		try {
			expect(encoder.encode(acceptance, undefined, []).length).toBeLessThanOrEqual(400)
		} finally {
			encoder.free()
		}
	})
})
