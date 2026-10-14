import { describe, expect, it } from "vitest"

import {
	agentLifecycleAssistantTextItemSchema,
	assistantMessageMetadataSchema,
	assistantMessagePhaseSchema,
	normalizeAssistantMessageMetadata,
} from "../index.js"

describe("assistant message contracts", () => {
	it.each([undefined, "commentary", "partial_answer", "final_answer"])(
		"roundtrips optional phase %s without changing lifecycle terminality",
		(phase) => {
			const item = {
				type: "assistant_text",
				itemId: "item-1",
				text: "Message.",
				messageId: "provider/msg-1",
				outputIndex: 0,
				...(phase === undefined ? {} : { phase }),
			}

			expect(agentLifecycleAssistantTextItemSchema.parse(JSON.parse(JSON.stringify(item)))).toEqual(item)
			expect(
				agentLifecycleAssistantTextItemSchema.parse({ type: "assistant_text", itemId: "old", text: "Old." }),
			).toEqual({
				type: "assistant_text",
				itemId: "old",
				text: "Old.",
			})
		},
	)

	it("validates known phases and finite output positions", () => {
		expect(assistantMessagePhaseSchema.options).toEqual(["commentary", "partial_answer", "final_answer"])
		for (const phase of ["working", "complete", null]) {
			expect(assistantMessageMetadataSchema.safeParse({ phase }).success).toBe(false)
		}
		for (const outputIndex of [-1, 0.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
			expect(assistantMessageMetadataSchema.safeParse({ outputIndex }).success).toBe(false)
		}
	})

	it.each([null, "future_phase"])("ignores unknown phase %s independently from valid source metadata", (phase) => {
		expect(normalizeAssistantMessageMetadata({ id: "original", phase, outputIndex: 0 })).toEqual({
			id: "original",
			outputIndex: 0,
		})
		expect(normalizeAssistantMessageMetadata({ id: 12, phase: "partial_answer", outputIndex: -1 })).toEqual({
			phase: "partial_answer",
		})
		expect(normalizeAssistantMessageMetadata(null)).toEqual({})
	})
})
