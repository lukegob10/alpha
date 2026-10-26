import type * as vscode from "vscode"
import { SYSTEM_PROMPT_FRAGMENTS, renderSystemPromptFragments } from "../system"
import { selectInheritedInstructionFragments } from "../inherited-instructions"
import { renderTaskMemoryContext } from "../../../services/memory/TaskMemoryContext"
import "../../../utils/path"

vi.mock("../sections/system-info", () => ({ getSystemInfoSection: () => "SYSTEM INFORMATION" }))

async function memoryPrompt(options: { mode?: "code" | "architect"; child?: boolean; context?: string } = {}) {
	return SYSTEM_PROMPT_FRAGMENTS(
		{} as vscode.ExtensionContext,
		process.cwd(),
		false,
		undefined,
		undefined,
		options.mode ?? "code",
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
			memoryContext: options.context,
			...(options.child
				? {
						subagentRole: "worker" as const,
						subagentUsesFrozenContext: true,
						subagentFrozenInstructions: "Parent's previously frozen learned reference",
					}
				: {}),
		},
		undefined,
		"gpt-6.1-sol",
	)
}

describe("memory prompt provenance", () => {
	it.each(["code", "architect"] as const)(
		"adds memory as advisory user data with exact provenance in %s mode",
		async (mode) => {
			const context = renderTaskMemoryContext("The test suite uses pnpm", "/alpha/memories_v2")
			const fragments = await memoryPrompt({ mode, context })
			const part = fragments.instructionParts.find(({ origin }) => origin === "alpha-memory")
			expect(part).toMatchObject({ role: "user", content: `\n\n${context}` })
			expect(selectInheritedInstructionFragments(fragments.instructionParts)).toContainEqual(part)
			expect(renderSystemPromptFragments(fragments)).toBe(
				fragments.instructionParts.map(({ content }) => content).join(""),
			)
		},
	)

	it("omits memory entirely when no summary was captured", async () => {
		const fragments = await memoryPrompt()
		expect(fragments.instructionParts.some(({ origin }) => origin === "alpha-memory")).toBe(false)
	})

	it("uses a child's inherited snapshot without introducing a second live memory fragment", async () => {
		const fragments = await memoryPrompt({ child: true, context: "New live memory that must not reach the child" })
		const rendered = renderSystemPromptFragments(fragments)
		expect(rendered).toContain("Parent's previously frozen learned reference")
		expect(rendered).not.toContain("New live memory that must not reach the child")
		expect(fragments.instructionParts.some(({ origin }) => origin === "alpha-memory")).toBe(false)
	})
})
