import { strict as assert } from "node:assert"
import { createHash } from "node:crypto"
import { snapshotVscodeLmThinking } from "@alpha-code/types"

export interface ClaudeRequestObservation {
	modelId: string
	family: string
	vendor: "copilot"
	includeEncryptedThinking: true
	tools: string[]
	thinkingDigests: string[]
}

export interface ClaudeThinkingEmission {
	request: number
	thinkingDigests: string[]
	nativeThinkingDigests: string[]
}

const object = (value: unknown): Record<string, unknown> | undefined =>
	value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined

/** Compare opaque wire state without retaining its text, signatures, or redacted payload. */
function thinkingDigest(value: unknown): string | undefined {
	const part = object(value)
	if (!part) return undefined
	const thinking = snapshotVscodeLmThinking(part)
	if (!thinking) return undefined
	const wire = {
		value: thinking.value,
		...(thinking.id !== undefined ? { id: thinking.id } : {}),
		...(thinking.metadata !== undefined ? { metadata: thinking.metadata } : {}),
	}
	return createHash("sha256").update(JSON.stringify(wire)).digest("hex")
}

export function persistedClaudeThinkingDigests(history: unknown): string[] {
	assert.ok(Array.isArray(history))
	return history.flatMap((message) => {
		const entry = object(message)
		if (entry?.role !== "assistant" || !Array.isArray(entry.content)) return []
		return entry.content.flatMap((part) => {
			if (object(part)?.type !== "vscode_lm_thinking") return []
			const digest = thinkingDigest(part)
			assert.ok(digest, "Persisted Claude thinking must be valid replayable wire state")
			return [digest]
		})
	})
}

/** Hash native emissions before the provider adapter can transform or discard them. */
export function observeClaudeThinkingEmission(
	observations: ClaudeThinkingEmission[],
	request: number,
	value: unknown,
	isRuntimeThinkingPart = false,
): void {
	const part = object(value)
	if (!part || (!isRuntimeThinkingPart && !("value" in part && ("id" in part || "metadata" in part)))) return
	const digest = thinkingDigest(part)
	assert.ok(digest, "Provider-emitted Claude thinking must be valid replayable wire state")
	let observation = observations.find((item) => item.request === request)
	if (!observation) {
		assert.ok(observations.length < 12, "Claude thinking observations must remain within the request cap")
		observation = { request, thinkingDigests: [], nativeThinkingDigests: [] }
		observations.push(observation)
	}
	assert.ok(
		observations.reduce((sum, emission) => sum + emission.thinkingDigests.length, 0) < 10_000,
		"Claude thinking observation exceeded its per-run part cap",
	)
	observation.thinkingDigests.push(digest)
	const encrypted = object(part.metadata)?.encrypted_content
	if (typeof encrypted === "string" && encrypted.length > 0) observation.nativeThinkingDigests.push(digest)
}

export function assertClaudeThinkingPersisted(emissions: readonly ClaudeThinkingEmission[], history: unknown): void {
	assert.deepEqual(
		persistedClaudeThinkingDigests(history),
		emissions.flatMap((emission) => emission.thinkingDigests),
		"Every provider-emitted Claude thinking payload must survive persistence in order",
	)
}

/**
 * Adaptive Claude may omit thinking at any effort; verify only the state actually emitted.
 * Official contract retrieved 2026-10-25: https://platform.claude.com/docs/en/build-with-claude/thinking-steering-and-cost
 */
export function assertClaudeThinkingRoundTrip(
	emissions: readonly ClaudeThinkingEmission[],
	history: unknown,
	outgoingDigests: readonly string[],
): "verified" | "not-emitted" {
	assertClaudeThinkingPersisted(emissions, history)
	assert.deepEqual(
		outgoingDigests,
		emissions.flatMap((emission) => emission.thinkingDigests),
		"Every provider-emitted Claude thinking payload must be replayed unchanged",
	)
	return emissions.some((emission) => emission.nativeThinkingDigests.length > 0) ? "verified" : "not-emitted"
}

/** Runs at the shared request-budget fence, including after handler replacement and model preparation. */
export function observeClaudeRequest(
	expected: { modelId: string; family: string },
	observations: ClaudeRequestObservation[],
	client: Record<string, unknown>,
	messages: unknown,
	options: unknown,
): void {
	assert.equal(client.id, expected.modelId, "The actual request must use the selected opaque Claude ID")
	assert.equal(client.vendor, "copilot", "Claude requests must use GitHub Copilot")
	assert.equal(client.family, expected.family, "A request cannot fall back to another model family")
	assert.ok(observations.length < 12, "Claude live observations must remain within their request cap")
	assert.ok(Array.isArray(messages))
	const tools = object(options)?.tools
	assert.ok(Array.isArray(tools))
	assert.equal(
		object(options)?.includeEncryptedThinking,
		true,
		"The native Copilot request must opt in to replayable Claude thinking",
	)
	observations.push({
		modelId: expected.modelId,
		family: expected.family,
		vendor: "copilot",
		includeEncryptedThinking: true,
		tools: tools.map((tool) => String(object(tool)?.name)),
		thinkingDigests: messages.flatMap((message) => {
			const content = object(message)?.content
			return Array.isArray(content)
				? content.flatMap((part) => {
						const entry = object(part)
						if (!entry || !("id" in entry || "metadata" in entry)) return []
						const digest = thinkingDigest(part)
						assert.ok(digest, "Outgoing Claude thinking must be valid replayable wire state")
						return [digest]
					})
				: []
		}),
	})
}
