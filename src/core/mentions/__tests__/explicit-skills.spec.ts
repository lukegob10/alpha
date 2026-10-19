import { parseMentions } from "../index"
import { processUserContentMentions } from "../processUserContentMentions"
import type { FileContextTracker } from "../../context-tracking/FileContextTracker"
import { extractExplicitSkillMentions } from "../../../shared/context-mentions"
import type { SkillContent } from "../../../shared/skills"
import { digestValue } from "../../agent/StepContext"
import { SkillSelectionError } from "../../../services/skills/SkillSelectionError"
import {
	getSkillLookupForCapturedCatalog,
	getSkillLookupForInput,
} from "../../../services/skills/skillInvocationProvenance"

vi.mock("vscode", () => ({ window: { showErrorMessage: vi.fn() } }))
vi.mock("../../../services/command/commands", () => ({ getCommand: vi.fn().mockResolvedValue(undefined) }))
vi.mock("../../../i18n", () => ({ t: (key: string) => key }))

const skill: SkillContent = {
	name: "review",
	source: "project",
	path: "/workspace/.agents/skills/review/SKILL.md",
	description: "Explicit review",
	allowImplicitInvocation: false,
	instructions: "REVIEW_INSTRUCTIONS",
}

function parse(text: string, lookup: Parameters<typeof parseMentions>[7], signal?: AbortSignal) {
	return parseMentions(text, "/workspace", undefined, undefined, false, true, 50, lookup, "code", undefined, signal)
}

describe("explicit skill requests", () => {
	it("recognizes names, namespaces, and exact linked paths without consuming connector links", () => {
		expect(
			extractExplicitSkillMentions(
				"Use $review, $project:review and [$review](skill:///a b/SKILL.md). [$app](app://id) $HOME \\$review",
			),
		).toEqual([
			{ name: "review", selector: "review" },
			{ name: "project:review", selector: "project:review" },
			{ name: "review", selector: "/a b/SKILL.md" },
			{ name: "HOME", selector: "HOME" },
		])
	})

	it("loads explicit-only dollar requests deterministically and deduplicates repeated identities", async () => {
		const manager = { getSkillContent: vi.fn(), getExplicitSkillContent: vi.fn().mockResolvedValue(skill) }
		const result = await parse("Use $review and $project:review; $review", manager)
		expect(manager.getExplicitSkillContent.mock.calls).toEqual([
			["review", "code"],
			["project:review", "code"],
		])
		expect(manager.getSkillContent).not.toHaveBeenCalled()
		expect(result.slashCommandHelp?.match(/REVIEW_INSTRUCTIONS/g)).toHaveLength(1)
		expect(result.mode).toBeUndefined()
		expect(result.loadedSkills).toEqual([
			{ name: skill.name, path: skill.path, digest: digestValue(skill.instructions) },
		])
	})

	it("keeps slash invocation and deduplicates it with a dollar mention", async () => {
		const manager = {
			getSkillContent: vi.fn().mockResolvedValue(skill),
			getExplicitSkillContent: vi.fn().mockResolvedValue(skill),
		}
		const result = await parse("/review $review", manager)
		expect(result.text).toContain("Command 'review'")
		expect(result.slashCommandHelp?.match(/REVIEW_INSTRUCTIONS/g)).toHaveLength(1)
	})

	it("does not fall back to a label when its exact selected identity is unavailable", async () => {
		const manager = {
			getSkillContent: vi.fn().mockResolvedValue(skill),
			getExplicitSkillContent: vi.fn().mockResolvedValue(null),
		}
		const result = await parse("Use [$review](/disabled/SKILL.md)", manager)
		expect(manager.getExplicitSkillContent).toHaveBeenCalledWith("/disabled/SKILL.md", "code")
		expect(manager.getSkillContent).not.toHaveBeenCalled()
		expect(result.slashCommandHelp).toContain("could not be loaded")
		expect(result.slashCommandHelp ?? "").not.toContain(skill.instructions)
	})

	it("keeps ambiguous and failed reads actionable without disclosing filesystem errors", async () => {
		const manager = {
			getSkillContent: vi.fn(),
			getExplicitSkillContent: vi.fn().mockRejectedValue(new Error("secret filesystem details")),
		}
		const result = await parse("$review", manager)
		expect(result.slashCommandHelp).toContain("unambiguous")
		expect(result.slashCommandHelp).not.toContain("secret")
	})

	it("shows only host-authored policy diagnostics directly", async () => {
		const manager = {
			getSkillContent: vi.fn(),
			getExplicitSkillContent: vi
				.fn()
				.mockRejectedValue(new SkillSelectionError("Enable the skill in Settings.")),
		}
		const result = await parse("$review", manager)
		expect(result.slashCommandHelp).toBe("Enable the skill in Settings.")
		expect(result.loadedSkills).toBeUndefined()
	})

	it("blocks explicit-only requests carried by nonhuman input through both lookup methods", async () => {
		const manager = {
			getSkillContent: vi.fn().mockResolvedValue(skill),
			getExplicitSkillContent: vi.fn().mockResolvedValue(skill),
		}
		const result = await parse("$review", getSkillLookupForInput(manager, false))
		expect(result.slashCommandHelp ?? "").not.toContain(skill.instructions)
	})

	it("propagates cancellation during an explicit read", async () => {
		const controller = new AbortController()
		let release!: (value: SkillContent) => void
		let markStarted!: () => void
		const started = new Promise<void>((resolve) => {
			markStarted = resolve
		})
		const manager = {
			getSkillContent: vi.fn(),
			getExplicitSkillContent: vi.fn(
				() =>
					new Promise<SkillContent>((resolve) => {
						release = resolve
						markStarted()
					}),
			),
		}
		const pending = parse("$review", manager, controller.signal)
		await started
		controller.abort()
		release(skill)
		await expect(pending).rejects.toMatchObject({ name: "AbortError" })
	})

	it("ignores unknown shell variables while allowing matching installed names", async () => {
		const manager = {
			getSkillContent: vi.fn(),
			getExplicitSkillContent: vi.fn(async (selector: string) =>
				selector === "PATH" ? { ...skill, name: "PATH" } : null,
			),
		}
		expect((await parse("Use $HOME", manager)).slashCommandHelp).toBeUndefined()
		expect((await parse("Use $PATH", manager)).slashCommandHelp).toContain("Skill: PATH")
	})

	it("retains frozen child paths, content digests, and explicit-only authority", async () => {
		const manager = {
			getSkillContent: vi.fn(),
			getExplicitSkillContent: vi.fn(),
			getSkillContentByPath: vi.fn().mockResolvedValue(skill),
		}
		const captured = [
			{
				name: skill.name,
				path: skill.path,
				digest: digestValue(skill.instructions),
				allowImplicitInvocation: false,
			},
		]
		const lookup = getSkillLookupForCapturedCatalog(manager, captured)
		expect((await parse(`[$review](${skill.path})`, lookup)).slashCommandHelp).toContain(skill.instructions)
		expect((await parse("[$review](/outside/SKILL.md)", lookup)).slashCommandHelp).not.toContain(skill.instructions)
		expect((await parse("$global:review", lookup)).slashCommandHelp).not.toContain(skill.instructions)
		expect((await parse("$review", getSkillLookupForInput(lookup, false))).slashCommandHelp ?? "").not.toContain(
			skill.instructions,
		)
		manager.getSkillContentByPath.mockResolvedValue({ ...skill, instructions: "CHANGED" })
		expect((await parse("$review", lookup)).slashCommandHelp ?? "").not.toContain("CHANGED")
		expect(manager.getExplicitSkillContent).not.toHaveBeenCalled()
		expect(manager.getSkillContent).not.toHaveBeenCalled()
	})

	it.each(["human", "agent", "tool", "human-feedback"] as const)(
		"expands hidden skills only with host-authenticated input provenance: %s",
		async (origin) => {
			const text = "<user_message>Use $review</user_message>"
			const manager = {
				getSkillContent: vi.fn().mockResolvedValue(skill),
				getExplicitSkillContent: vi.fn().mockResolvedValue(skill),
			}
			const result = await processUserContentMentions({
				userContent:
					origin === "tool" || origin === "human-feedback"
						? [{ type: "tool_result", tool_use_id: "feedback", content: text }]
						: [{ type: "text", text }],
				cwd: "/workspace",
				fileContextTracker: {} as FileContextTracker,
				skillsManager: manager,
				inputOrigin: origin === "human" ? "human" : "agent",
				humanFeedbackToolResultIds: origin === "human-feedback" ? new Set(["feedback"]) : undefined,
			})
			expect(JSON.stringify(result.content).includes(skill.instructions)).toBe(
				origin === "human" || origin === "human-feedback",
			)
			expect(result.loadedSkills).toEqual(
				origin === "human" || origin === "human-feedback"
					? [{ name: skill.name, path: skill.path, digest: digestValue(skill.instructions) }]
					: undefined,
			)
		},
	)

	it("records loaded identities in source order when asynchronous blocks finish out of order", async () => {
		const secondSkill = { ...skill, name: "second", path: "/skills/second/SKILL.md" }
		let releaseFirst!: (content: SkillContent) => void
		let markSecondStarted!: () => void
		const secondStarted = new Promise<void>((resolve) => {
			markSecondStarted = resolve
		})
		const manager = {
			getSkillContent: vi.fn(),
			getExplicitSkillContent: vi.fn(async (selector: string) => {
				if (selector === "review")
					return new Promise<SkillContent>((resolve) => {
						releaseFirst = resolve
					})
				markSecondStarted()
				return secondSkill
			}),
		}
		const pending = processUserContentMentions({
			userContent: [
				{ type: "text", text: "<user_message>$review</user_message>" },
				{ type: "text", text: "<user_message>$second</user_message>" },
			],
			cwd: "/workspace",
			fileContextTracker: {} as FileContextTracker,
			skillsManager: manager,
		})
		await secondStarted
		releaseFirst(skill)
		expect((await pending).loadedSkills?.map(({ name }) => name)).toEqual(["review", "second"])
	})
})
