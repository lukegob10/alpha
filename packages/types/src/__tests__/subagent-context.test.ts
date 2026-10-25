import { createHash } from "node:crypto"

import {
	agentRuntimeSnapshotSchema,
	historyItemSchema,
	isSubagentForkTurns,
	subagentContextManifestSchema,
	subagentAutoApprovalPolicySchema,
	subagentCommandApprovalPolicySchema,
	subagentForkTurnsSchema,
	SUBAGENT_SKILL_DESCRIPTION_MAX_LENGTH,
	SUBAGENT_SKILL_DESCRIPTIONS_MAX_BYTES,
	getSubagentSkillDescriptionsByteLength,
	type SubagentContextManifest,
	type SubagentContextSkill,
} from "../index.js"

const digest = (value: string) => value.repeat(64)

function makeManifest(override: Partial<SubagentContextManifest> = {}): SubagentContextManifest {
	return {
		version: 1,
		parentTaskId: "parent-1",
		capturedAt: 1_700_000_000_000,
		requestedForkTurns: "none",
		selectedUserTurns: { count: 0, refs: [] },
		contextRefs: ["parent:parent-1:instructions"],
		workspace: { cwd: "F:/workspace", roots: ["F:/workspace"] },
		instructions: {
			digest: digest("a"),
			sources: [{ kind: "agents", ref: "F:/workspace/AGENTS.md", digest: digest("b") }],
		},
		skills: [{ name: "typescript", path: "F:/skills/typescript/SKILL.md", digest: digest("c") }],
		modelRoute: {
			source: "parent",
			resolution: "selected",
			profileId: "profile-1",
			profileName: "Default",
			provider: "openai-native",
			modelId: "gpt-5",
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
			allowedTools: ["read_file", "search_files"],
			workspaceRoots: ["F:/workspace"],
			digest: digest("d"),
		},
		manifestDigest: digest("e"),
		...override,
	}
}

function firstSkill(manifest: SubagentContextManifest): SubagentContextSkill {
	const skill = manifest.skills[0]
	if (skill === undefined) throw new Error("Expected a captured skill in this test fixture")
	return skill
}

describe("legacy subagent manifest compatibility", () => {
	it("preserves historical manifests without materializing a personality field", () => {
		expect(subagentContextManifestSchema.parse(makeManifest())).not.toHaveProperty("personality")
	})

	it.each(["default", "friendly", "pragmatic", "none"] as const)(
		"retains %s through a saved manifest round trip",
		(personality) => {
			const saved = JSON.stringify(subagentContextManifestSchema.parse(makeManifest({ personality })))
			expect(subagentContextManifestSchema.parse(JSON.parse(saved)).personality).toBe(personality)
		},
	)

	it.each([null, true, "casual", "None", ""])("rejects unsupported personality %j", (personality) => {
		expect(subagentContextManifestSchema.safeParse({ ...makeManifest(), personality }).success).toBe(false)
	})
})

describe("inherited subagent authority", () => {
	it.each(["explore", "review", "worker"] as const)("retains parent authority for a new %s role", (role) => {
		const manifest = makeManifest()
		manifest.runtimePolicy = {
			...manifest.runtimePolicy,
			role,
			authorityModel: "parent",
			mode: "code",
			execute: true,
			mutate: true,
			network: true,
			externalSideEffects: true,
			writeScope: ["."],
		}
		expect(subagentContextManifestSchema.parse(manifest).runtimePolicy).toEqual(manifest.runtimePolicy)
	})

	it("keeps old roles read-only and requires an explicit scope for inherited writes", () => {
		const manifest = makeManifest()
		manifest.runtimePolicy.execute = true
		expect(subagentContextManifestSchema.safeParse(manifest).success).toBe(false)
		manifest.runtimePolicy.authorityModel = "parent"
		manifest.runtimePolicy.mutate = true
		expect(subagentContextManifestSchema.safeParse(manifest).success).toBe(false)
	})
})

function descriptionQuotaSkills(totalBytes: number, fullDescription: string) {
	const propertyBytes = (description: string) =>
		Buffer.byteLength(`,"description":${JSON.stringify(description)}`, "utf8")
	const entry = (description: string): SubagentContextManifest["skills"][number] => ({
		name: "repeated-quota-skill",
		path: "/skills/repeated-quota-skill/SKILL.md",
		digest: digest("c"),
		description,
		allowImplicitInvocation: false,
	})
	const fullBytes = propertyBytes(fullDescription)
	const fullCount = Math.floor((totalBytes - 18) / fullBytes)
	const skills = Array.from({ length: fullCount }, () => entry(fullDescription))
	let remaining = totalBytes - fullCount * fullBytes
	while (remaining > 1_041) {
		const bytes = Math.min(1_041, remaining - 18)
		skills.push(entry("a".repeat(bytes - 17)))
		remaining -= bytes
	}
	skills.push(entry("a".repeat(remaining - 17)))
	return skills
}

describe("frozen skill description metadata", () => {
	it("keeps the approved entry and aggregate limits explicit", () => {
		expect(SUBAGENT_SKILL_DESCRIPTION_MAX_LENGTH).toBe(1_024)
		expect(SUBAGENT_SKILL_DESCRIPTIONS_MAX_BYTES).toBe(1_048_576)
	})

	it("preserves exact legacy bytes and their hash without inserting a description default", () => {
		const legacy = makeManifest()
		const serialized = JSON.stringify(legacy)
		const legacyHash = createHash("sha256").update(serialized).digest("hex")
		const reloaded = subagentContextManifestSchema.parse(JSON.parse(serialized))
		const restored = JSON.stringify(reloaded)

		expect(restored).toBe(serialized)
		expect(createHash("sha256").update(restored).digest("hex")).toBe(legacyHash)
		expect(reloaded.manifestDigest).toBe(legacy.manifestDigest)
		expect(reloaded.skills[0]).not.toHaveProperty("description")
		expect(getSubagentSkillDescriptionsByteLength(reloaded.skills)).toBe(0)
	})

	it("round-trips exact frozen descriptions through saved history and runtime snapshots", () => {
		const original = makeManifest()
		const description = '  Review the signed release: é 😀 "quoted"\\path\nNext stage  '
		const manifest = subagentContextManifestSchema.parse({
			...original,
			skills: [{ ...original.skills[0], description, allowImplicitInvocation: false }],
		})
		const history = historyItemSchema.parse({
			id: "child-description",
			number: 1,
			ts: 1,
			task: "Review frozen skill metadata",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			subagentContextManifest: JSON.parse(JSON.stringify(manifest)),
		})
		const snapshot = agentRuntimeSnapshotSchema.parse({ contextManifest: JSON.parse(JSON.stringify(manifest)) })

		expect(firstSkill(manifest).description).toBe(description)
		expect(history.subagentContextManifest?.skills).toEqual(manifest.skills)
		expect(snapshot.contextManifest?.skills).toEqual(manifest.skills)
		expect(firstSkill(manifest).digest).toBe(firstSkill(original).digest)
		expect(manifest.contextRefs).toEqual(original.contextRefs)
	})

	it.each(["x", "  keep admitted whitespace  ", "x".repeat(1_024), "😀".repeat(512)])(
		"retains a nonblank description without transforming its UTF-16 content: %j",
		(description) => {
			const original = makeManifest()
			const manifest = subagentContextManifestSchema.parse({
				...original,
				skills: [{ ...original.skills[0], description }],
			})
			expect(firstSkill(manifest).description).toBe(description)
		},
	)

	it.each(["", " \t\n", "\u00a0", "x".repeat(1_025), "😀".repeat(513), null, 0, {}])(
		"rejects blank, nonstring or overlong descriptions: %j",
		(description) => {
			const original = makeManifest()
			expect(
				subagentContextManifestSchema.safeParse({
					...original,
					skills: [{ ...original.skills[0], description }],
				}).success,
			).toBe(false)
		},
	)

	it.each([
		{ skills: [{}], expected: 0 },
		{ skills: [{ description: "a" }], expected: 18 },
		{ skills: [{ description: "é" }], expected: 19 },
		{ skills: [{ description: "😀" }], expected: 21 },
		{ skills: [{ description: '\n"\\\u0000' }], expected: 29 },
	])("counts canonical escaped UTF-8 property bytes: $expected", ({ skills, expected }) => {
		expect(getSubagentSkillDescriptionsByteLength(skills)).toBe(expected)
	})

	it("charges every hidden and duplicate occurrence instead of deduplicating metadata", () => {
		const skill = { ...firstSkill(makeManifest()), description: "é", allowImplicitInvocation: false }
		const skills = [skill, skill, { ...skill }]
		expect(getSubagentSkillDescriptionsByteLength(skills)).toBe(57)
		expect(subagentContextManifestSchema.parse(makeManifest({ skills })).skills).toHaveLength(3)
	})

	it.each(["a".repeat(1_024), '😀"\\\n\u0000'.repeat(100)])(
		"accepts exactly 1 MiB and rejects one additional escaped UTF-8 byte",
		(fullDescription) => {
			const atLimit = descriptionQuotaSkills(1_048_576, fullDescription)
			const overLimit = descriptionQuotaSkills(1_048_577, fullDescription)
			expect(getSubagentSkillDescriptionsByteLength(atLimit)).toBe(1_048_576)
			expect(getSubagentSkillDescriptionsByteLength(overLimit)).toBe(1_048_577)
			expect(subagentContextManifestSchema.safeParse(makeManifest({ skills: atLimit })).success).toBe(true)
			expect(subagentContextManifestSchema.safeParse(makeManifest({ skills: overLimit })).success).toBe(false)
		},
	)

	it("charges no description payload for legacy identities regardless of other metadata size", () => {
		const skill: SubagentContextSkill = {
			name: "legacy",
			path: "/" + "x".repeat(1_048_577),
			digest: digest("c"),
		}
		expect(getSubagentSkillDescriptionsByteLength([skill])).toBe(0)
	})
})

describe("explicit sub-agent context contracts", () => {
	it("retains legacy hashed command policies exactly on reload", () => {
		const legacy = {
			algorithm: "sha256-salted-prefix-v1",
			salt: digest("1"),
			allowAll: true,
			denyAll: false,
			allowed: [],
			denied: [{ prefixLength: 8, digest: digest("2") }],
		}
		expect(subagentCommandApprovalPolicySchema.parse(JSON.parse(JSON.stringify(legacy)))).toEqual(legacy)
	})

	it("supports frozen argv policies alongside legacy ancestor ceilings", () => {
		const tokenPolicy = {
			algorithm: "sha256-salted-argv-v2",
			platform: "win32",
			salt: digest("1"),
			allowAll: false,
			denyAll: false,
			unresolvedDenyRules: false,
			allowed: [{ tokenCount: 2, digest: digest("2") }],
			denied: [{ tokenCount: 1, digest: digest("3") }],
		}
		const legacy = {
			algorithm: "sha256-salted-prefix-v1",
			salt: digest("4"),
			allowAll: true,
			denyAll: false,
			allowed: [],
			denied: [{ prefixLength: 8, digest: digest("5") }],
		}
		const captured = {
			autoApprovalEnabled: true,
			alwaysAllowReadOnly: true,
			alwaysAllowReadOnlyOutsideWorkspace: false,
			alwaysAllowWrite: false,
			alwaysAllowWriteOutsideWorkspace: false,
			alwaysAllowWriteProtected: false,
			alwaysAllowExecute: true,
			alwaysAllowSubagents: false,
			commandApproval: tokenPolicy,
			commandApprovalCeilings: [legacy, tokenPolicy],
		}
		expect(subagentAutoApprovalPolicySchema.parse(JSON.parse(JSON.stringify(captured)))).toEqual(captured)
		expect(subagentCommandApprovalPolicySchema.safeParse({ ...tokenPolicy, platform: undefined }).success).toBe(
			false,
		)
		expect(
			subagentCommandApprovalPolicySchema.safeParse({
				...tokenPolicy,
				allowed: [{ prefixLength: 2, digest: digest("2") }],
			}).success,
		).toBe(false)
		expect(
			subagentCommandApprovalPolicySchema.safeParse({ ...legacy, algorithm: "sha256-salted-unknown-v3" }).success,
		).toBe(false)
	})

	it.each(["none", "all", "1", "42", "9007199254740991"])("accepts canonical fork_turns %j", (value) => {
		expect(subagentForkTurnsSchema.parse(value)).toBe(value)
		expect(isSubagentForkTurns(value)).toBe(true)
	})

	it.each([undefined, null, 1, "", "0", "01", "+1", "-1", "1.0", "9007199254740992"])(
		"rejects noncanonical fork_turns %j",
		(value) => {
			expect(subagentForkTurnsSchema.safeParse(value).success).toBe(false)
			expect(isSubagentForkTurns(value)).toBe(false)
		},
	)

	it("persists the credential-free manifest in history and control snapshots", () => {
		const manifest = subagentContextManifestSchema.parse(makeManifest())
		const history = historyItemSchema.parse({
			id: "child-1",
			number: 1,
			ts: 1,
			task: "Review context inheritance",
			tokensIn: 0,
			tokensOut: 0,
			totalCost: 0,
			subagentContextManifest: manifest,
			subagentInstructionPlacement: "system",
		})
		const snapshot = agentRuntimeSnapshotSchema.parse({ contextManifest: manifest })

		expect(history.subagentContextManifest).toEqual(manifest)
		expect(history.subagentInstructionPlacement).toBe("system")
		expect(snapshot.contextManifest).toEqual(manifest)
		expect(JSON.stringify(manifest)).not.toMatch(/apiKey|authorization|conversationBody/i)
		expect(historyItemSchema.safeParse({ ...history, subagentInstructionPlacement: "user" }).success).toBe(false)
	})

	it("records selected turn ordinals, source indexes, references, and digests without bodies", () => {
		const manifest = makeManifest({
			requestedForkTurns: "1",
			selectedUserTurns: {
				count: 1,
				refs: [
					{
						ref: "parent:parent-1:turn:3",
						ordinal: 3,
						sourceMessageIndexes: [6, 7],
						digest: digest("f"),
					},
				],
			},
		})

		expect(subagentContextManifestSchema.parse(manifest).selectedUserTurns.refs[0]).toEqual({
			ref: "parent:parent-1:turn:3",
			ordinal: 3,
			sourceMessageIndexes: [6, 7],
			digest: digest("f"),
		})
		expect(
			subagentContextManifestSchema.safeParse({
				...manifest,
				selectedUserTurns: {
					...manifest.selectedUserTurns,
					refs: [{ ...manifest.selectedUserTurns.refs[0], body: "secret parent conversation" }],
				},
			}).success,
		).toBe(false)
	})

	it.each([true, false])(
		"round-trips captured skill invocation policy %j in saved history",
		(allowImplicitInvocation) => {
			const original = makeManifest()
			const manifest = subagentContextManifestSchema.parse({
				...original,
				skills: [{ ...original.skills[0], allowImplicitInvocation }],
			})
			const history = historyItemSchema.parse({
				id: "child-with-policy",
				number: 1,
				ts: 1,
				task: "Use a captured skill",
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
				subagentContextManifest: JSON.parse(JSON.stringify(manifest)),
			})
			expect(history.subagentContextManifest?.skills).toEqual(manifest.skills)
			expect(manifest.skills[0]?.allowImplicitInvocation).toBe(allowImplicitInvocation)
			expect(subagentContextManifestSchema.parse(original).skills[0]).not.toHaveProperty(
				"allowImplicitInvocation",
			)
		},
	)

	it.each(["false", 0, null, []])("rejects invalid captured invocation policy %j", (allowImplicitInvocation) => {
		const original = makeManifest()
		expect(
			subagentContextManifestSchema.safeParse({
				...original,
				skills: [{ ...original.skills[0], allowImplicitInvocation }],
			}).success,
		).toBe(false)
	})

	it("rejects inconsistent selection metadata and credential-bearing route fields", () => {
		expect(
			subagentContextManifestSchema.safeParse({
				...makeManifest(),
				selectedUserTurns: { count: 1, refs: [] },
			}).success,
		).toBe(false)
		expect(
			subagentContextManifestSchema.safeParse({
				...makeManifest(),
				modelRoute: { ...makeManifest().modelRoute, apiKey: "do-not-persist" },
			}).success,
		).toBe(false)
	})
})
