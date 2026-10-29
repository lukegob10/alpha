import type { AlphaMessage } from "./message.js"
import type { ExtensionMessage, ExtensionState } from "./vscode-extension-host.js"

interface LegacyTranscriptFields {
	clineMessage?: AlphaMessage
	clineMessages?: AlphaMessage[]
	clineMessagesSeq?: number
}

type CompatibleExtensionMessage = ExtensionMessage &
	LegacyTranscriptFields & { state?: Partial<ExtensionState> & LegacyTranscriptFields }

function isTranscriptMessage(value: unknown): value is AlphaMessage {
	if (!value || typeof value !== "object") return false
	const message = value as Record<string, unknown>
	// Check the stable envelope while preserving fields from older/newer hosts.
	return (
		typeof message.ts === "number" &&
		Number.isFinite(message.ts) &&
		(message.type === "ask" || message.type === "say") &&
		(message.text === undefined || typeof message.text === "string") &&
		(message.partial === undefined || typeof message.partial === "boolean")
	)
}

function isTranscript(value: unknown): value is AlphaMessage[] {
	if (!Array.isArray(value)) return false
	for (const message of value) {
		if (!isTranscriptMessage(message)) return false
	}
	return true
}

/** A host using older transcript field names can outlive rebuilt webview assets. */
export function normalizeExtensionMessageTranscript(message: CompatibleExtensionMessage): ExtensionMessage | undefined {
	const incoming = message
	if (message.type === "messageCreated" || message.type === "messageUpdated") {
		const alphaMessage = Object.hasOwn(incoming, "alphaMessage") ? incoming.alphaMessage : incoming.clineMessage
		const alphaMessagesSeq = Object.hasOwn(incoming, "alphaMessagesSeq")
			? incoming.alphaMessagesSeq
			: incoming.clineMessagesSeq
		if (!isTranscriptMessage(alphaMessage)) return undefined
		if (alphaMessagesSeq !== undefined && (!Number.isSafeInteger(alphaMessagesSeq) || alphaMessagesSeq < 0)) {
			return undefined
		}
		if (alphaMessage === message.alphaMessage && alphaMessagesSeq === message.alphaMessagesSeq) return message
		const { clineMessage: _legacyMessage, clineMessagesSeq: _legacySequence, ...rest } = incoming
		return { ...rest, alphaMessage, alphaMessagesSeq }
	}

	if (message.type !== "state" || !message.state || typeof message.state !== "object") return message
	const state = message.state
	const hasTranscript = Object.hasOwn(state, "alphaMessages") || Object.hasOwn(state, "clineMessages")
	const alphaMessages = Object.hasOwn(state, "alphaMessages") ? state.alphaMessages : state.clineMessages
	const alphaMessagesSeq = Object.hasOwn(state, "alphaMessagesSeq") ? state.alphaMessagesSeq : state.clineMessagesSeq
	const validTranscript = !hasTranscript || isTranscript(alphaMessages)
	const validSequence =
		alphaMessagesSeq === undefined || (Number.isSafeInteger(alphaMessagesSeq) && alphaMessagesSeq >= 0)
	// Reject the whole publication so task identity cannot outrun its transcript.
	if (!validTranscript || !validSequence) return undefined
	if (!Object.hasOwn(state, "clineMessages") && !Object.hasOwn(state, "clineMessagesSeq")) {
		return message
	}

	const { clineMessages: _legacyMessages, clineMessagesSeq: _legacySequence, ...normalized } = state
	if (hasTranscript) normalized.alphaMessages = alphaMessages
	if (alphaMessagesSeq !== undefined) normalized.alphaMessagesSeq = alphaMessagesSeq
	return { ...message, state: normalized }
}
