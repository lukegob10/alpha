import { beforeAll, describe, expect, it } from "vitest"
import i18next from "i18next"
import common from "../../../i18n/locales/en/common.json"
import {
	captureSubagentContext,
	isValidSubagentContextManifest,
	serializeSubagentContextManifest,
} from "../SubagentContextCapture"

interface SkillInput {
	name: string
	path: string
	content: string
	description?: string
	allowImplicitInvocation?: boolean
}

beforeAll(() => {
	i18next.addResourceBundle("en", "common", common, true, true)
})

const skill: SkillInput = { name: "review", path: "/skills/review/SKILL.md", content: "Captured body" }

function capture(skills: SkillInput[] = [skill]) {
	const cwd = process.cwd()
	return captureSubagentContext({
		parentTaskId: "ws07-public-parent",
		capturedAt: 1,
		forkTurns: "none",
		history: [],
		instructions: {
			effectiveText: "Frozen instructions",
			sources: [{ kind: "aggregate", ref: "fixture:instructions", text: "Frozen instructions" }],
		},
		skills,
		cwd,
		workspaceRoots: [cwd],
		modelRoute: {
			source: "parent",
			resolution: "selected",
			profileName: "Default",
			provider: "openai",
			modelId: "fixture",
		},
		runtimePolicy: {
			role: "review",
			read: true,
			execute: false,
			mutate: false,
			delegate: false,
			network: false,
			externalSideEffects: false,
			requireApproval: true,
			allowedTools: ["read_file", "skill"],
			workspaceRoots: [cwd],
		},
	})
}

function quotaSkills(lastLength: number): SkillInput[] {
	return [
		...Array.from({ length: 1_007 }, () => ({
			...skill,
			description: "a".repeat(1_024),
			allowImplicitInvocation: false,
		})),
		{ ...skill, description: "a".repeat(lastLength), allowImplicitInvocation: false },
	]
}

function descriptionBytes(skills: SkillInput[]): number {
	return skills.reduce(
		(total, entry) =>
			total +
			(entry.description === undefined
				? 0
				: Buffer.byteLength(`,"description":${JSON.stringify(entry.description)}`, "utf8")),
		0,
	)
}

describe("WS07 public frozen description capture", () => {
	it("keeps the absent-description legacy serialization and digest control stable", () => {
		const original = capture().manifest
		const bytes = serializeSubagentContextManifest(original)
		const restored = JSON.parse(bytes)
		expect(isValidSubagentContextManifest(restored)).toBe(true)
		expect(serializeSubagentContextManifest(restored)).toBe(bytes)
		expect(restored.manifestDigest).toBe(original.manifestDigest)
		expect(restored.skills[0]).not.toHaveProperty("description")
	})

	it("binds supplied exact relevance metadata while leaving body contextRefs and authority unchanged", () => {
		const legacy = capture().manifest
		const description = '  Review 😀 é "release"\\path\nNext stage  '
		const captured = capture([{ ...skill, description }]).manifest
		const restored = JSON.parse(serializeSubagentContextManifest(captured))
		expect(restored.skills[0]).toMatchObject({ description })
		expect(restored.skills[0].digest).toBe(legacy.skills[0].digest)
		expect(restored.contextRefs).toEqual(legacy.contextRefs)
		expect(restored.runtimePolicy).toEqual(legacy.runtimePolicy)
		expect(restored.manifestDigest).not.toBe(legacy.manifestDigest)
		restored.skills[0].description = "Changed relevance only"
		expect(isValidSubagentContextManifest(restored)).toBe(false)
	})

	it.each(["x".repeat(1_024), "😀".repeat(512), " keep admitted whitespace "])(
		"retains a valid supplied UTF16 description without transformation: %j",
		(description) => expect(capture([{ ...skill, description }]).manifest.skills[0]).toMatchObject({ description }),
	)

	it.each(["", " \t\n", "x".repeat(1_025), "😀".repeat(513)])(
		"rejects a blank or overlong supplied description after the public capture path runs: %j",
		(description) => expect(() => capture([{ ...skill, description }])).toThrow(),
	)

	it("admits exactly one MiB of hidden duplicate description property bytes", () => {
		const skills = quotaSkills(272)
		expect(descriptionBytes(skills)).toBe(1_048_576)
		const captured = capture(skills).manifest
		expect(isValidSubagentContextManifest(captured)).toBe(true)
		expect(captured.skills).toHaveLength(1_008)
		expect(captured.skills[0]).toMatchObject({ description: "a".repeat(1_024), allowImplicitInvocation: false })
	})

	it("rejects one byte beyond the inclusive property budget without importing a future helper", () => {
		const skills = quotaSkills(273)
		expect(descriptionBytes(skills)).toBe(1_048_577)
		expect(() => capture(skills)).toThrow(/Captured skill descriptions exceed 1048576 bytes/)
	})
})
