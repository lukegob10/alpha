import type { AlphaMessage, AlphaMessageTurn } from "@alpha-code/types"

import { projectTranscriptTurns, transcriptTurnIdentity } from "../utils/transcriptTurns"

const identity = { runId: "run", turnId: "first" }

function message(ts: number, turn?: AlphaMessageTurn, say: AlphaMessage["say"] = "text"): AlphaMessage {
	return { ts, type: "say", say, text: `row ${ts}`, ...(turn ? { turn } : {}) }
}

describe("transcript turn attribution", () => {
	it("preserves one canonical turn across steering and records the exact accepted final", () => {
		const prompt = message(100, { ...identity, inputKind: "start" }, "user_feedback")
		const messages = [
			message(200, identity),
			message(300, { ...identity, inputKind: "steer" }, "user_feedback"),
			message(400, identity, "reasoning"),
			message(500, { ...identity, inputKind: "steer" }, "user_feedback"),
			message(600, { ...identity, terminalStatus: "completed" }),
			message(700, { runId: "run", turnId: "second", inputKind: "start" }, "user_feedback"),
		]

		const turns = projectTranscriptTurns(messages, prompt)
		expect(turns).toHaveLength(2)
		expect(turns[0]).toEqual({
			id: transcriptTurnIdentity(identity),
			source: "canonical",
			indices: [0, 1, 2, 3, 4],
			promptIndex: -1,
			startTs: 100,
			terminalIndex: 4,
			terminalStatus: "completed",
		})
		expect(turns[1]).toMatchObject({ indices: [5], promptIndex: 5, startTs: 700 })
		expect(messages.map(({ text }) => text)).toEqual([
			"row 200",
			"row 300",
			"row 400",
			"row 500",
			"row 600",
			"row 700",
		])
	})

	it("does not assign unattributed technical rows to the surrounding canonical turn", () => {
		const messages = [
			message(100, { ...identity, inputKind: "start" }, "user_feedback"),
			message(200, identity),
			message(300, undefined, "checkpoint_saved"),
			message(400, { ...identity, terminalStatus: "completed" }),
		]
		expect(projectTranscriptTurns(messages).map(({ source, indices }) => ({ source, indices }))).toEqual([
			{ source: "canonical", indices: [0, 1, 3] },
			{ source: "legacy", indices: [2] },
		])
	})

	it.each(["another explicit turn", "an unattributed user input"])(
		"retains one canonical owner around %s without assigning the intervening row",
		(barrier) => {
			const middle =
				barrier === "another explicit turn"
					? message(200, { runId: "other", turnId: "first", inputKind: "start" }, "user_feedback")
					: message(200, undefined, "user_feedback")
			const turns = projectTranscriptTurns([
				message(100, identity),
				middle,
				message(300, { ...identity, terminalStatus: "completed" }),
			])
			expect(turns.map(({ indices }) => indices)).toEqual([[0, 2], [1]])
			expect(new Set(turns.map(({ id }) => id)).size).toBe(2)
			expect(turns[0]).toMatchObject({
				id: transcriptTurnIdentity(identity),
				terminalStatus: "completed",
				terminalIndex: 2,
			})
		},
	)

	it("keeps legacy boundaries and requires explicit completed content", () => {
		const turns = projectTranscriptTurns(
			[
				message(200),
				message(300, undefined, "completion_result"),
				message(400, undefined, "user_feedback"),
				message(500),
			],
			100,
		)
		expect(turns).toEqual([
			{
				id: 100,
				source: "legacy",
				indices: [0, 1],
				promptIndex: -1,
				startTs: 100,
				terminalIndex: 1,
				terminalStatus: "completed",
			},
			{ id: 400, source: "legacy", indices: [2, 3], promptIndex: 2, startTs: 400 },
		])
	})

	it("does not treat completion text or a partial terminal publication as an accepted canonical final", () => {
		const messages = [
			message(100, identity),
			message(200, identity, "completion_result"),
			{ ...message(300, { ...identity, terminalStatus: "completed" }), partial: true },
		]
		expect(projectTranscriptTurns(messages)[0].terminalIndex).toBeUndefined()
	})

	it.each(["failed", "interrupted"] as const)(
		"does not replace a %s terminal receipt with a later success claim",
		(terminalStatus) => {
			const turn = projectTranscriptTurns([
				message(100, { ...identity, terminalStatus }),
				message(200, { ...identity, terminalStatus: "completed" }),
			])[0]
			expect(turn).toMatchObject({ terminalStatus, terminalIndex: 0 })
		},
	)

	it("uses collision-free, selector-safe canonical identity components", () => {
		expect(transcriptTurnIdentity({ runId: "one:two", turnId: "three" })).not.toBe(
			transcriptTurnIdentity({ runId: "one", turnId: "two:three" }),
		)
		expect(transcriptTurnIdentity({ runId: 'run"\n', turnId: "\ud800" })).not.toMatch(/["\n]/)
	})
})
