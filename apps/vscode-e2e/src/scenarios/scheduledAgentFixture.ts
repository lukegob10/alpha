import type { RequestUserInputQuestion } from "@alpha-code/types"

export const SCHEDULED_FOREGROUND_PROMPT = "Retain this foreground task while the schedule runs."
const questionId = "foreground_action"
const answer = "Check authority (Recommended)"

export function scheduledForegroundInput(): {
	name: "request_user_input"
	arguments: { questions: RequestUserInputQuestion[] }
} {
	return {
		name: "request_user_input",
		arguments: {
			questions: [
				{
					id: questionId,
					header: "Foreground",
					question: "When should the foreground continue?",
					options: [
						{
							label: answer,
							description: "Check the foreground approval after the background run finishes.",
						},
						{ label: "Keep waiting", description: "Leave this foreground conversation paused." },
					],
				},
			],
		},
	}
}

export const SCHEDULED_FOREGROUND_RESPONSE = JSON.stringify({ answers: { [questionId]: { answers: [answer] } } })

export const SCHEDULED_RECEIPT_CONTENT = "SCHEDULE_EFFECT\n"

export const SCHEDULED_VERIFIER_SOURCE = String.raw`const fs = require("node:fs")
const path = require("node:path")
const assert = require("node:assert/strict")
const receipt = fs.readFileSync(path.join(__dirname, "receipt.txt"), "utf8")
// VS Code text edits preserve the host's configured LF or CRLF line ending.
assert.equal(receipt.replace(/\r\n/g, "\n"), "SCHEDULE_EFFECT\n")
console.log("SCHEDULE_VERIFIED")
`
