import type { AlphaMessage, AlphaMessageTurn } from "@alpha-code/types"

export type TranscriptPrompt = number | Pick<AlphaMessage, "ts" | "turn">

export interface TranscriptTurn {
	id: string | number
	source: "canonical" | "legacy"
	/** Source indices stay ordered; unattributed rows never acquire canonical ownership. */
	indices: number[]
	promptIndex?: number
	startTs: number
	terminalIndex?: number
	terminalStatus?: AlphaMessageTurn["terminalStatus"]
}

export function transcriptTurnIdentity(turn: Pick<AlphaMessageTurn, "runId" | "turnId">): string {
	return `turn:${encodeURIComponent(JSON.stringify([turn.runId, turn.turnId]))}`
}

/** Project saved host attribution without reconstructing lifecycle from presentation text. */
export function projectTranscriptTurns(
	messages: readonly AlphaMessage[],
	initialPrompt?: TranscriptPrompt,
): TranscriptTurn[] {
	const turns: TranscriptTurn[] = []
	const canonicalTurns = new Map<string, TranscriptTurn>()
	let legacy: TranscriptTurn | undefined
	const prompt: Pick<AlphaMessage, "ts" | "turn"> | undefined =
		typeof initialPrompt === "number" ? { ts: initialPrompt } : initialPrompt
	if (prompt && Number.isFinite(prompt.ts) && prompt.ts > 0) {
		const turn: TranscriptTurn = {
			id: prompt.turn ? transcriptTurnIdentity(prompt.turn) : prompt.ts,
			source: prompt.turn ? "canonical" : "legacy",
			indices: [],
			promptIndex: -1,
			startTs: prompt.ts,
		}
		turns.push(turn)
		if (prompt.turn) {
			canonicalTurns.set(String(turn.id), turn)
		} else {
			legacy = turn
		}
	}

	for (const [index, message] of messages.entries()) {
		if (message.turn) {
			const identity = transcriptTurnIdentity(message.turn)
			let canonical = canonicalTurns.get(identity)
			if (!canonical) {
				canonical = {
					id: identity,
					source: "canonical",
					indices: [],
					startTs: message.ts,
				}
				canonicalTurns.set(identity, canonical)
				turns.push(canonical)
			}
			legacy = undefined
			canonical.indices.push(index)
			if (message.turn.inputKind === "start" && canonical.promptIndex === undefined) {
				canonical.promptIndex = index
				canonical.startTs = message.ts
			}
			if (message.turn.terminalStatus && message.partial !== true) {
				// Conflicting terminal receipts cannot turn an interrupted or failed turn into success.
				if (canonical.terminalStatus === undefined || canonical.terminalStatus === "completed") {
					canonical.terminalStatus = message.turn.terminalStatus
					canonical.terminalIndex = index
				}
			}
			continue
		}

		const isPrompt = message.type === "say" && message.say === "user_feedback"
		if (!legacy || isPrompt) {
			legacy = {
				id: message.ts,
				source: "legacy",
				indices: [],
				...(isPrompt ? { promptIndex: index } : {}),
				startTs: message.ts,
			}
			turns.push(legacy)
		}
		legacy.indices.push(index)
		if (
			legacy.terminalIndex === undefined &&
			message.type === "say" &&
			message.say === "completion_result" &&
			message.partial !== true
		) {
			legacy.terminalIndex = index
			legacy.terminalStatus = "completed"
		}
	}

	return turns.filter((turn) => turn.indices.length > 0)
}
