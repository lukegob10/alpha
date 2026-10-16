import type * as vscode from "vscode"
import { describe, expect, it, vi } from "vitest"
import type { SkillsManager } from "../../../services/skills/SkillsManager"
import { SYSTEM_PROMPT_FRAGMENTS, renderSystemPromptFragments } from "../system"
import "../../../utils/path"

vi.mock("../sections/system-info", () => ({ getSystemInfoSection: () => "SYSTEM INFORMATION" }))

async function childPrompt(hasSkills: boolean) {
	const manager = {
		getSkillsForMode: vi.fn(() => {
			throw new Error("A frozen child cannot consult live metadata")
		}),
	}
	const fragments = await SYSTEM_PROMPT_FRAGMENTS(
		{} as vscode.ExtensionContext,
		process.cwd(),
		false,
		undefined,
		undefined,
		"code",
		undefined,
		undefined,
		undefined,
		{},
		undefined,
		undefined,
		{
			todoListEnabled: false,
			useAgentRules: false,
			newTaskRequireTodos: false,
			subagentRole: "review",
			subagentHasInheritedSkills: hasSkills,
			subagentUsesFrozenContext: true,
			subagentFrozenInstructions: "Frozen repository instructions",
		},
		undefined,
		"gpt-6.1-sol",
		manager as unknown as SkillsManager,
	)
	return { fragments, manager, rendered: renderSystemPromptFragments(fragments) }
}

describe("fixed skill guidance for a frozen managed child", () => {
	it("includes applicable upstream skill instructions without consulting or duplicating the live catalog", async () => {
		const { fragments, manager, rendered } = await childPrompt(true)
		const overlay = fragments.instructionParts.find(({ origin }) => origin === "alpha-feature-overlay")

		expect(overlay).toMatchObject({ role: "developer" })
		expect(overlay?.content).toContain("<skill_guidance>")
		expect(overlay?.content).toContain("If the user names a skill (with `$SkillName` or plain text)")
		expect(overlay?.content).toContain(
			"The main agent must read each required instruction or reference file itself",
		)
		expect(overlay?.content).toContain(
			"Use only skill identities included in this child's frozen inherited catalog",
		)
		expect(rendered).not.toContain("<available_skills>")
		expect(manager.getSkillsForMode).not.toHaveBeenCalled()
	})

	it("omits skill invocation guidance when the child's frozen context contains no skill identities", async () => {
		const { manager, rendered } = await childPrompt(false)

		expect(rendered).not.toContain("<skill_guidance>")
		expect(rendered).not.toContain("<available_skills>")
		expect(manager.getSkillsForMode).not.toHaveBeenCalled()
	})
})
