import { getSkillsCatalogSection, getSkillsSection } from "../skills"

const pdfSkill = {
	name: "pdf-processing",
	description: "Extracts text & tables from PDFs",
	path: "/abs/path/pdf-processing/SKILL.md",
	source: "global" as const,
}

function mockSkillsManager(skills = [pdfSkill]) {
	return {
		getSkillsForMode: vi.fn().mockReturnValue(skills),
	}
}

describe("getSkillsSection", () => {
	it("should emit <available_skills> XML with name, description, and location", async () => {
		const result = await getSkillsSection(mockSkillsManager(), "code")

		expect(result).toContain("<available_skills>")
		expect(result).toContain("</available_skills>")
		expect(result).toContain("<skill>")
		expect(result).toContain("<name>pdf-processing</name>")
		// Ensure XML escaping for '&'
		expect(result).toContain("<description>Extracts text &amp; tables from PDFs</description>")
		// For filesystem-based agents, location should be the absolute path to SKILL.md
		expect(result).toContain("<location>/abs/path/pdf-processing/SKILL.md</location>")
		expect(result).toContain("Resolve skill-relative paths against the directory containing the selected SKILL.md")
		expect(result).toContain("Use the resolved absolute path with file tools")
	})

	it("should return empty string when skillsManager or currentMode is missing", async () => {
		await expect(getSkillsSection(undefined, "code")).resolves.toBe("")
		await expect(getSkillsSection({ getSkillsForMode: vi.fn() }, undefined)).resolves.toBe("")
	})

	it("omits the pre-response skill-applicability ritual", async () => {
		const result = await getSkillsSection(mockSkillsManager(), "code")

		expect(result).not.toContain("mandatory_skill_check")
		expect(result).not.toContain("skill_check_completed")
		expect(result).not.toContain("REQUIRED PRECONDITION")
		expect(result).not.toContain("Do NOT skip this check")
		expect(result).not.toContain("Before producing ANY user-facing response")
		expect(result).not.toContain("<internal_verification>")
	})

	it("keeps optional catalog guidance, no-match, compaction, and linked-file disclosure", async () => {
		const result = await getSkillsSection(mockSkillsManager(), "code")

		expect(result).toContain("<skill_guidance>")
		expect(result).toContain("Load a skill only when a <description> clearly and unambiguously matches")
		expect(result).toContain("when the user names a skill or asks to use it")
		expect(result).toContain("No match means proceed with zero skill tool calls")
		expect(result).toContain("without a skill tool call")
		expect(result).toContain("No match is not an error")
		expect(result).toContain("Do NOT load every skill")
		expect(result).toContain("After compaction, a saved skill identity is not its instructions")
		expect(result).toContain("reload relevant instructions when absent")
		expect(result).toContain("Treat linked files as progressive disclosure, not mandatory context")
		expect(result).toContain("Files linked from the skill are NOT loaded automatically")
	})
})

describe("getSkillsCatalogSection", () => {
	it("returns an empty section when the catalog or mode is missing", () => {
		expect(getSkillsCatalogSection([], "code")).toBe("")
		expect(getSkillsCatalogSection([pdfSkill], undefined)).toBe("")
	})

	it("escapes XML special characters in name, description, and location", () => {
		const result = getSkillsCatalogSection(
			[
				{
					name: `create<"mode">`,
					description: `Use A & B with <xml> and "quotes" and 'apostrophes'`,
					path: `/abs/path/create<"mode">/SKILL.md`,
				},
			],
			"architect",
		)

		expect(result).toContain("<name>create&lt;&quot;mode&quot;&gt;</name>")
		expect(result).toContain(
			"<description>Use A &amp; B with &lt;xml&gt; and &quot;quotes&quot; and &apos;apostrophes&apos;</description>",
		)
		expect(result).toContain("<location>/abs/path/create&lt;&quot;mode&quot;&gt;/SKILL.md</location>")
		expect(result).toContain('The skill list is already filtered for the current mode: "architect".')
	})
})
