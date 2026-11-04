import { parseMentions } from "../core/mentions"
import type { SkillContent } from "../shared/skills"
import type { SkillLookup } from "../services/skills/skillInvocation"

const skill = (name: string): SkillContent => ({
	name,
	description: `${name} workflow`,
	path: `/workspace/.agents/skills/${name}/SKILL.md`,
	source: "project",
	instructions: `${name.toUpperCase()}_INSTRUCTIONS`,
})
const parse = (
	text: string,
	getSkillContent: SkillLookup["getSkillContent"] = vi.fn(async () => null),
	signal?: AbortSignal,
) =>
	parseMentions(
		text,
		"/workspace",
		undefined,
		undefined,
		false,
		true,
		50,
		{ getSkillContent },
		"code",
		undefined,
		signal,
	)

describe("slash skill invocation", () => {
	it("loads a named skill and keeps the user's prompt", async () => {
		const getSkillContent = vi.fn().mockResolvedValue(skill("review"))
		const result = await parse("/review inspect this change", getSkillContent)
		expect(getSkillContent).toHaveBeenCalledWith("review", "code")
		expect(result.text).toContain("inspect this change")
		expect(result.slashCommandHelp).toContain("REVIEW_INSTRUCTIONS")
		expect(result.mode).toBeUndefined()
	})

	it("keeps unknown or unavailable skill names literal", async () => {
		const result = await parse("/unavailable inspect this change")
		expect(result.text).toBe("/unavailable inspect this change")
		expect(result.slashCommandHelp).toBeUndefined()
	})

	it("deduplicates repeated skills and preserves invocation order when reads finish out of order", async () => {
		let finishFirst!: (value: SkillContent) => void
		const getSkillContent = vi.fn((name: string) =>
			name === "first"
				? new Promise<SkillContent>((resolve) => {
						finishFirst = resolve
					})
				: Promise.resolve(skill(name)),
		)
		const pending = parse("/first /second /first", getSkillContent)
		finishFirst(skill("first"))
		const result = await pending
		expect(getSkillContent).toHaveBeenCalledTimes(2)
		expect(result.slashCommandHelp?.match(/FIRST_INSTRUCTIONS/g)).toHaveLength(1)
		expect(result.slashCommandHelp!.indexOf("FIRST_INSTRUCTIONS")).toBeLessThan(
			result.slashCommandHelp!.indexOf("SECOND_INSTRUCTIONS"),
		)
	})

	it("keeps /plan mode admission atomic without expanding skills in its remainder", async () => {
		const getSkillContent = vi.fn().mockResolvedValue(skill("review"))
		const result = await parse("/plan /review inspect this change", getSkillContent)
		expect(result).toMatchObject({
			mode: "architect",
			text: "/review inspect this change",
			slashCommandHelp: undefined,
		})
		expect(getSkillContent).not.toHaveBeenCalled()
	})

	it("propagates cancellation while a slash skill is loading", async () => {
		const controller = new AbortController()
		let finish!: (value: SkillContent) => void
		const getSkillContent = vi.fn(
			() =>
				new Promise<SkillContent>((resolve) => {
					finish = resolve
				}),
		)
		const pending = parse("/review", getSkillContent, controller.signal)
		controller.abort()
		finish(skill("review"))
		await expect(pending).rejects.toThrow()
	})
})
