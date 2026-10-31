import { describe, expect, it } from "vitest"
import { getSkillsCatalogSectionParts, type SkillCatalogEntry } from "../skills"

function entry(index: number, description = "D".repeat(1_024)): SkillCatalogEntry {
	const name = `skill-${String(index).padStart(4, "0")}`
	return { name, description, path: `/skills/${name}/SKILL.md` }
}

function metadata(catalog: string): string {
	const match = /<available_skills>\n?([\s\S]*?)\n?<\/available_skills>/.exec(catalog)
	expect(match).not.toBeNull()
	return match![1]
}

function descriptions(catalog: string): string[] {
	return [...catalog.matchAll(/<description>([\s\S]*?)<\/description>/g)].map((match) => match[1])
}

describe("captured skill catalog context budget", () => {
	it.each([{}, { contextWindow: 200_000 }])(
		"does not read descriptions when the minimum catalog already exceeds its budget: %o",
		(options) => {
			let descriptionReads = 0
			const skills = Array.from({ length: 1_000 }, (_, index) => ({
				...entry(index, ""),
				get description() {
					descriptionReads++
					return "D".repeat(1_024)
				},
			}))
			const parts = getSkillsCatalogSectionParts(skills, "code", options)
			const emptyDescriptions = Array.from({ length: skills.length }, (_, index) => entry(index, ""))

			expect(parts).toEqual(getSkillsCatalogSectionParts(emptyDescriptions, "code", options))
			expect(parts.catalog).toContain("additional skills omitted from this bounded skills list.")
			expect(descriptionReads).toBe(0)
		},
	)

	it("bounds a 1,000-skill repeated catalog at the 8,000-character fallback", () => {
		const skills = Array.from({ length: 1_000 }, (_, index) => entry(index))
		const parts = getSkillsCatalogSectionParts(skills, "code")

		expect(Array.from(metadata(parts.catalog)).length).toBeLessThanOrEqual(8_000)
		expect(parts.catalog).toContain("<name>skill-0000</name>")
		expect(parts.catalog).not.toContain("<name>skill-0999</name>")
		expect(parts.guidance).toMatch(/action.{0,30}list/)
		expect(parts.catalog).toContain("additional skills omitted from this bounded skills list.")
		expect(parts.catalog).not.toContain("D".repeat(1_024))
	})

	it("keeps every identity and fairly reduces descriptions when the minimum catalog fits", () => {
		const skills = ["one", "two", "six"].map((name) => ({
			name,
			description: "D".repeat(1_024),
			path: `/skills/${name}/SKILL.md`,
		}))
		const parts = getSkillsCatalogSectionParts(skills, "code", { maxMetadataTokens: 180 })
		const renderedDescriptions = descriptions(parts.catalog)

		for (const skill of skills) {
			expect(parts.catalog).toContain(`<name>${skill.name}</name>`)
			expect(parts.catalog).toContain(`<location>${skill.path}</location>`)
		}
		expect(Math.ceil(Buffer.byteLength(metadata(parts.catalog), "utf8") / 4)).toBeLessThanOrEqual(180)
		expect(renderedDescriptions).toHaveLength(skills.length)
		expect(Math.min(...renderedDescriptions.map((value) => value.length))).toBeGreaterThan(0)
		expect(
			Math.max(...renderedDescriptions.map((value) => value.length)) -
				Math.min(...renderedDescriptions.map((value) => value.length)),
		).toBeLessThanOrEqual(1)
		expect(parts.catalog).not.toContain("additional skills were not included")
	})

	it("derives two percent from the captured model window and lets the explicit budget override it", () => {
		const skills = Array.from({ length: 50 }, (_, index) => entry(index))
		const small = getSkillsCatalogSectionParts(skills, "code", { contextWindow: 1_000 })
		const overridden = getSkillsCatalogSectionParts(skills, "code", {
			contextWindow: 1_000,
			maxMetadataTokens: 500,
		})

		expect(Math.ceil(Buffer.byteLength(metadata(small.catalog), "utf8") / 4)).toBeLessThanOrEqual(20)
		expect(Math.ceil(Buffer.byteLength(metadata(overridden.catalog), "utf8") / 4)).toBeLessThanOrEqual(500)
		expect((overridden.catalog.match(/<skill>/g) ?? []).length).toBeGreaterThan(
			(small.catalog.match(/<skill>/g) ?? []).length,
		)
		expect(small.guidance).toMatch(/action.{0,30}list/)
	})

	it("caps the explicitly configured allowance at 10,000 tokens", () => {
		const parts = getSkillsCatalogSectionParts(
			Array.from({ length: 200 }, (_, index) => entry(index)),
			"code",
			{ maxMetadataTokens: 1_000_000 },
		)

		expect(Math.ceil(Buffer.byteLength(metadata(parts.catalog), "utf8") / 4)).toBeLessThanOrEqual(10_000)
	})

	it("charges escaped Unicode metadata after encoding and never cuts a character or XML entity", () => {
		const parts = getSkillsCatalogSectionParts(
			Array.from({ length: 20 }, (_, index) => ({
				...entry(index, "😀<&\"'>".repeat(100)),
				path: `/skills/<&>/skill-${index}/SKILL.md`,
			})),
			"code",
			{ maxMetadataTokens: 1_000 },
		)
		const rendered = metadata(parts.catalog)

		expect(Math.ceil(Buffer.byteLength(rendered, "utf8") / 4)).toBeLessThanOrEqual(1_000)
		expect(rendered).toBe(Buffer.from(rendered, "utf8").toString("utf8"))
		expect(rendered).not.toContain("�")
		expect(rendered).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/)
		expect(rendered).toContain("&lt;&amp;&gt;")
	})

	it("preserves captured order and data while hiding explicit-only metadata before allocation", () => {
		const hidden = Object.freeze({ ...entry(99), name: "explicit-secret", allowImplicitInvocation: false })
		const skills = Object.freeze([
			Object.freeze(entry(3, "Third")),
			hidden,
			Object.freeze(entry(1, "First")),
			Object.freeze(entry(2, "Second")),
		])
		const before = JSON.stringify(skills)
		const options = Object.freeze({ maxMetadataTokens: 1_000 })
		const first = getSkillsCatalogSectionParts(skills, "code", options)
		const second = getSkillsCatalogSectionParts(skills, "code", options)

		expect(first).toEqual(second)
		expect(first.catalog.indexOf("skill-0003")).toBeLessThan(first.catalog.indexOf("skill-0001"))
		expect(first.catalog.indexOf("skill-0001")).toBeLessThan(first.catalog.indexOf("skill-0002"))
		for (const value of [hidden.name, hidden.path]) expect(first.catalog).not.toContain(value)
		expect(JSON.stringify(skills)).toBe(before)
	})

	it.each([{ contextWindow: Number.NaN }, { contextWindow: -1 }, { maxMetadataTokens: Number.POSITIVE_INFINITY }])(
		"falls back safely when the captured allowance is invalid: %o",
		(options) => {
			const parts = getSkillsCatalogSectionParts(
				Array.from({ length: 100 }, (_, index) => entry(index)),
				"code",
				options,
			)
			expect(Array.from(metadata(parts.catalog)).length).toBeLessThanOrEqual(8_000)
		},
	)

	it("retains the empty contract for missing modes and explicit-only catalogs", () => {
		const skills = [{ ...entry(1), allowImplicitInvocation: false }]
		expect(getSkillsCatalogSectionParts(skills, "code", { maxMetadataTokens: 1 })).toEqual({
			catalog: "",
			guidance: "",
		})
		expect(getSkillsCatalogSectionParts([entry(1)], undefined, { maxMetadataTokens: 1 })).toEqual({
			catalog: "",
			guidance: "",
		})
	})
})
