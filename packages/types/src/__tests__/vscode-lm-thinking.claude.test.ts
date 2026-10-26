import { describe, expect, it } from "vitest"

import { snapshotVscodeLmThinking, type VscodeLmThinkingHistoryBlock } from "../vscode-lm-thinking.js"

// Microsoft Claude metadata contracts retrieved 2026-10-25:
// extensions/copilot/src/extension/byok/common/anthropicMessageConverter.ts and
// extensions/copilot/src/platform/thinking/common/thinking.ts in microsoft/vscode.
describe("Claude thinking state through Copilot", () => {
	it.each([
		{ signature: "signature-only", vscode_thinking_origin_api: "messages" },
		{ redactedData: "opaque-redacted-data", vscode_thinking_origin_api: "messages" },
		{ _completeThinking: "complete thought", signature: "complete-signature" },
		{ vscode_reasoning_done: true },
	])("retains metadata-only thinking across JSON persistence: %#", (metadata) => {
		const state: VscodeLmThinkingHistoryBlock = {
			type: "vscode_lm_thinking",
			value: "",
			id: "claude-thinking-1",
			metadata,
			modelId: "claude-sonnet-4.5",
			modelVendor: "copilot",
			modelVersion: "20250929",
		}
		const persisted: unknown = JSON.parse(JSON.stringify(state))

		expect(snapshotVscodeLmThinking(persisted)).toEqual({
			value: "",
			id: state.id,
			metadata,
			modelId: state.modelId,
			modelVendor: state.modelVendor,
			modelVersion: state.modelVersion,
		})
	})

	it("retains segmented thinking, opaque provider origin and exact model provenance", () => {
		const source = {
			value: ["first segment", "second segment"],
			id: "claude-thinking-2",
			metadata: {
				vscode_thinking_origin_api: "messages",
				signature: "opaque+/=signature",
				_completeThinking: "first segmentsecond segment",
			},
			modelId: "claude-opus-4.6",
			modelVendor: "copilot",
			modelVersion: "host-reported-version",
		}
		const expected = structuredClone(source)
		const snapshot = snapshotVscodeLmThinking(source)
		source.value[0] = "later mutation"
		source.metadata.signature = "replacement signature"
		source.metadata.vscode_thinking_origin_api = "responses"
		source.modelId = "different-model"

		expect(snapshot).toEqual(expected)
		expect(snapshotVscodeLmThinking(JSON.parse(JSON.stringify(snapshot)))).toEqual(expected)
	})

	it("keeps legacy Claude state readable without inventing model provenance", () => {
		const legacy = {
			value: "",
			metadata: { redactedData: "legacy-opaque-data", signature: "legacy-signature" },
		}
		expect(snapshotVscodeLmThinking(legacy)).toEqual(legacy)
	})

	it.each([
		{ modelId: null },
		{ modelId: ["claude-sonnet-4.5"] },
		{ modelVendor: 1 },
		{ modelVendor: { vendor: "copilot" } },
		{ modelVersion: null },
		{ modelVersion: ["20250929"] },
	])("rejects malformed provenance instead of losing the Claude replay boundary: %#", (provenance) => {
		expect(
			snapshotVscodeLmThinking({
				value: "",
				metadata: { signature: "opaque-signature", vscode_thinking_origin_api: "messages" },
				...provenance,
			}),
		).toBeUndefined()
	})
})
