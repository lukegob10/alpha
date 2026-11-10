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
	it.each(["gpt-6.1-sol", "claude-sonnet-4-5"])(
		"supplies requirement-based acceptance without AGENTS.md for %s while retaining the model base",
		async (model) => {
			const fragments = await acceptancePrompt({}, "code", model)
			const prompt = renderSystemPromptFragments(fragments)
			expect(prompt).toContain("ACCEPTANCE OF IMPLEMENTED WORK")
			expect(prompt).toContain("Could these checks pass while the requested behavior is wrong?")
			expect(prompt).toContain("requirement, check, observed result, and remaining gap")
			expect(prompt).toContain("mocks, excluded state, and unexercised supported conditions")
			expect(prompt).toContain("Questions and trivial edits do not need an extra review phase")
			expect(fragments.instructionParts[0]?.content).toBe(resolveCodexModelPrompt(model).instructions)
			expect(fragments.instructionParts.map(({ content }) => content).join("")).toBe(prompt)
		},
	)

	it("keeps combined acceptance with the parent and checks the integrated workspace", async () => {
		const prompt = renderSystemPromptFragments(await acceptancePrompt())
		expect(prompt).toContain("parent goal, shared constraints, and dependency contracts")
		expect(prompt).toContain("combined user workflow in the final integrated workspace")
		expect(prompt).toContain("Reuse relevant results while their code, inputs, and environment remain valid")
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
