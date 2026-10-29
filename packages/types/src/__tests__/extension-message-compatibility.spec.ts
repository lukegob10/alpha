import { describe, expect, test } from "vitest"

import { normalizeExtensionMessageTranscript } from "../extension-message-compatibility.js"
import type { AlphaMessage } from "../message.js"
import type { ExtensionMessage } from "../vscode-extension-host.js"

const prompt: AlphaMessage = { ts: 1, type: "say", say: "user_feedback", text: "Please fix the failing test" }

describe("extension transcript wire compatibility", () => {
	test("keeps canonical publications and message identities unchanged", () => {
		const created: ExtensionMessage = { type: "messageCreated", alphaMessage: prompt, alphaMessagesSeq: 1 }
		const state: ExtensionMessage = { type: "state", state: { alphaMessages: [prompt], alphaMessagesSeq: 1 } }
		expect(normalizeExtensionMessageTranscript(created)).toBe(created)
		expect(normalizeExtensionMessageTranscript(state)).toBe(state)
	})

	test("normalizes legacy fields without copying or losing transcript metadata", () => {
		const messages = [{ ...prompt, futureMetadata: { signature: "opaque" } }]
		const legacy = { type: "state" as const, state: { clineMessages: messages, clineMessagesSeq: 7 } }
		const normalized = normalizeExtensionMessageTranscript(legacy)
		expect(normalized?.state).toEqual({ alphaMessages: messages, alphaMessagesSeq: 7 })
		expect(normalized?.state?.alphaMessages).toBe(messages)
		expect(legacy.state).toEqual({ clineMessages: messages, clineMessagesSeq: 7 })
	})

	test.each(["messageCreated", "messageUpdated"] as const)("normalizes a legacy %s publication", (type) => {
		const normalized = normalizeExtensionMessageTranscript({ type, clineMessage: prompt, clineMessagesSeq: 3 })
		expect(normalized).toEqual({ type, alphaMessage: prompt, alphaMessagesSeq: 3 })
		expect(normalized?.alphaMessage).toBe(prompt)
	})

	test("uses canonical fields when both naming forms are present", () => {
		const canonical: ExtensionMessage = {
			type: "messageCreated",
			alphaMessage: prompt,
			alphaMessagesSeq: 5,
		}
		const mixed = { ...canonical, clineMessage: { ...prompt, text: "stale" }, clineMessagesSeq: 4 }
		expect(normalizeExtensionMessageTranscript(mixed)?.alphaMessage).toBe(prompt)
		expect(normalizeExtensionMessageTranscript(mixed)?.alphaMessagesSeq).toBe(5)
	})

	test.each([undefined, null, "message", {}, { ts: 1 }, { ts: 1, type: "say", text: 3 }])(
		"rejects malformed incremental payload %j",
		(alphaMessage) => {
			const wire = { type: "messageCreated", alphaMessage } as ExtensionMessage
			expect(normalizeExtensionMessageTranscript(wire)).toBeUndefined()
		},
	)

	test("rejects malformed snapshots including sparse arrays without consuming their sequence", () => {
		for (const alphaMessages of [[prompt, undefined], [prompt, null], new Array(1), null]) {
			const wire = { type: "state", state: { alphaMessages, alphaMessagesSeq: 8 } } as ExtensionMessage
			expect(normalizeExtensionMessageTranscript(wire)).toBeUndefined()
		}
	})

	test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("rejects invalid transcript sequence %j", (sequence) => {
		expect(
			normalizeExtensionMessageTranscript({
				type: "messageCreated",
				alphaMessage: prompt,
				alphaMessagesSeq: sequence,
			}),
		).toBeUndefined()
	})
})
