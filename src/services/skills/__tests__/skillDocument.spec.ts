import { describe, expect, it } from "vitest"
import { parseImportedSkillDocument } from "../skillDocument"

describe("portable skill prose compatibility", () => {
	it("repairs prose scalars while preserving literal blocks and all instruction bytes", () => {
		const body = "Keep this body: intact\n😀\n"
		const parsed = parseImportedSkillDocument(
			`---\nname: demo\ndescription: Build for AWS: ECS\nmetadata:\n  notes: |\n    description: Keep: this text\n---\n${body}`,
		)
		expect(parsed.data.description).toBe("Build for AWS: ECS")
		expect(parsed.data.metadata.notes).toBe("description: Keep: this text\n")
		expect(parsed.content).toBe(body)
	})

	it("retains unrelated malformed YAML as an error", () => {
		expect(() =>
			parseImportedSkillDocument("---\nname: demo\ndescription: AWS: ECS\nother: [\n---\nBody"),
		).toThrow()
	})

	it.each(["javascript", "js", "json"])(
		"rejects a %s language selector before any metadata engine runs",
		(language) => {
			expect(() => parseImportedSkillDocument(`---${language}\n({ name: 'demo' })\n---\nBody`)).toThrow()
		},
	)

	it("does not reuse a failed gray-matter cache entry as an instruction body", () => {
		const contents = "---\ndescription: Build for AWS: ECS\n---\nInstructions\n"
		expect(parseImportedSkillDocument(contents).content).toBe("Instructions\n")
		expect(parseImportedSkillDocument(contents).content).toBe("Instructions\n")
	})
})
