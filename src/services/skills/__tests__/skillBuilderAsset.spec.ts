import { existsSync, readFileSync } from "fs"
import path from "path"
import matter from "gray-matter"

describe("packaged skill-builder", () => {
	const skillDirectory = path.join(__dirname, "../../../assets/skills/skill-builder")
	const skillPath = path.join(skillDirectory, "SKILL.md")
	const source = readFileSync(skillPath, "utf8")
	const parsed = matter(source)

	it("ships a portable, discoverable activation contract", () => {
		expect(parsed.data).toEqual({
			name: "skill-builder",
			description: expect.any(String),
		})
		expect(parsed.data.description).toContain("Create, revise, migrate, and evaluate")
		expect(parsed.data.description).toContain("Use when")
		expect(parsed.data.description).toContain("Do not use")
		expect(parsed.data.description.length).toBeLessThanOrEqual(1024)
		expect(source.split(/\r?\n/u).length).toBeLessThanOrEqual(500)
	})

	it("contains a complete workflow instead of a generated placeholder", () => {
		for (const required of [
			"Establish the contract",
			"Design before writing",
			"standards-compliant frontmatter",
			"Write executable instructions",
			"Verify behavior, not just syntax",
			"positive trigger prompts and three negative",
			"Write every new project skill to `.agents/skills/<name>/` by default",
			"Never claim a skill loaded, triggered, or passed a check that was not actually run",
		]) {
			expect(parsed.content).toContain(required)
		}
		expect(parsed.content).not.toContain("Add your skill instructions here.")
		expect(parsed.content).not.toContain("For Alpha-only project skills")
	})

	it("links only to packaged, direct progressive-disclosure references", () => {
		const links = [...parsed.content.matchAll(/\]\((references\/[^)#]+)\)/gu)].map((match) => match[1])
		expect(links.sort()).toEqual(["references/evaluation.md", "references/standard-and-hosts.md"])
		for (const relative of links) {
			expect(relative).not.toContain("..")
			expect(existsSync(path.join(skillDirectory, relative))).toBe(true)
		}
	})

	it("documents the open standard, target hosts, sources, and behavior evaluation", () => {
		const standards = readFileSync(path.join(skillDirectory, "references/standard-and-hosts.md"), "utf8")
		for (const required of [
			"Sources were checked on 2026-09-20",
			"https://agentskills.io/specification",
			"## Alpha profile",
			"## Cursor profile",
			"## Claude Code profile",
			"## Codex profile",
			"current validator accepts only the six portable fields",
			"Create every new Alpha project skill under `.agents/skills/`",
			"~/.cursor/skills-cursor/",
			"Compatibility means verified behavior",
		]) {
			expect(standards).toContain(required)
		}

		const evaluation = readFileSync(path.join(skillDirectory, "references/evaluation.md"), "utf8")
		for (const required of [
			"Test activation independently",
			"should_trigger",
			"Prefer deterministic checks",
			"Test workflow behavior",
			"Permission denial or cancellation",
			"Completion criteria",
		]) {
			expect(evaluation).toContain(required)
		}
	})
})
