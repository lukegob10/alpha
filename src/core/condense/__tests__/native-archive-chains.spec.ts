import { describe, expect, it } from "vitest"
import type { NativeCompactionCheckpoint } from "@alpha-code/types"
import { buildOpenAiResponsesInput } from "../../../api/providers/openai-responses"
import type { ApiMessage } from "../../task-persistence/apiMessages"
import { invalidateOpaqueProviderStateReplay } from "../../task-persistence/providerStateScope"
import { getEffectiveApiHistory } from "../index"

const scope = { provider: "openai-native" as const, modelId: "gpt-6.1-sol" }
const checkpoint = (id: string): NativeCompactionCheckpoint => ({
	protocol: "openai-responses",
	...scope,
	responseId: id,
	output: [{ type: "compaction", id, encrypted_content: `opaque-${id}` }],
})
const nativeSummary = (id: string, parent?: string): ApiMessage => ({
	role: "assistant",
	content: [],
	isSummary: true,
	condenseId: id,
	...(parent ? { condenseParent: parent } : {}),
	native_compaction: checkpoint(id),
	provider_state_scope: scope,
})
const history = (): ApiMessage[] => [
	{ role: "user", content: "Before the local summary.", condenseParent: "local" },
	{
		role: "assistant",
		content: "LOCAL: preserve the user's project guidance.",
		isSummary: true,
		condenseId: "local",
		condenseParent: "native-1",
	},
	{ role: "user", content: "Read only the approved fixture.", condenseParent: "native-1" },
	{
		role: "assistant",
		condenseParent: "native-1",
		content: [{ type: "tool_use", id: "read-once", name: "read_file", input: { path: "fixture.ts" } }],
	},
	{
		role: "user",
		condenseParent: "native-1",
		content: [{ type: "tool_result", tool_use_id: "read-once", content: "approved fixture", is_error: false }],
	},
	nativeSummary("native-1", "native-2"),
	{ role: "user", content: "STEER: retain this correction after recovery.", condenseParent: "native-2" },
	nativeSummary("native-2"),
]

// Independently specified stored trace: local summary -> native checkpoint ->
// native checkpoint. Removing/revoking the latest checkpoint must not lose its archive.
describe("native compaction archive chains", () => {
	it("keeps the current native window and restores the latest usable local summary on route/model changes", () => {
		const original = history()
		const before = structuredClone(original)
		expect(getEffectiveApiHistory(original, scope)).toEqual([original[7]])
		for (const destination of [null, { ...scope, modelId: "gpt-6-astra" }]) {
			const restored = getEffectiveApiHistory(original, destination)
			expect(restored).toEqual([original[1], original[2], original[3], original[4], original[6]])
			const input = buildOpenAiResponsesInput("Current host instructions", [], restored, false, true, {
				providerId: scope.provider,
				modelId: scope.modelId,
			})
			expect(JSON.stringify(input)).not.toContain("opaque-")
			expect(JSON.stringify(input)).toContain("LOCAL: preserve")
			expect(JSON.stringify(input)).toContain("STEER: retain")
			expect(input.filter((item) => item.type === "function_call")).toEqual([
				expect.objectContaining({ call_id: "read-once", name: "read_file" }),
			])
			expect(input.filter((item) => item.type === "function_call_output")).toEqual([
				expect.objectContaining({ call_id: "read-once" }),
			])
		}
		expect(original).toEqual(before)
	})

	it("keeps account revocation effective even when the original provider/model is selected again", () => {
		const revoked = invalidateOpaqueProviderStateReplay(history())
		expect(revoked.filter((message) => message.native_compaction)).toHaveLength(2)
		expect(
			revoked
				.filter((message) => message.native_compaction)
				.every((message) => message.provider_state_replay_disabled === true),
		).toBe(true)
		const restored = getEffectiveApiHistory(JSON.parse(JSON.stringify(revoked)), scope)
		expect(restored.map((message) => message.content)).toEqual([
			revoked[1].content,
			revoked[2].content,
			revoked[3].content,
			revoked[4].content,
			revoked[6].content,
		])
		expect(restored.some((message) => message.native_compaction)).toBe(false)
	})

	it("rewinding the latest native marker exposes its prior checkpoint and later correction exactly once", () => {
		const original = history()
		const rewound = original.slice(0, -1)
		expect(getEffectiveApiHistory(rewound, scope)).toEqual([original[5], original[6]])
		expect(getEffectiveApiHistory(rewound, null)).toEqual([
			original[1],
			original[2],
			original[3],
			original[4],
			original[6],
		])
	})
})
