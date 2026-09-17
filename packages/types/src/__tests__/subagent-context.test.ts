import {
	agentRuntimeSnapshotSchema,
	historyItemSchema,
	isSubagentForkTurns,
	subagentContextManifestSchema,
	subagentForkTurnsSchema,
	type SubagentContextManifest,
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

describe("explicit sub-agent context contracts", () => {
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
