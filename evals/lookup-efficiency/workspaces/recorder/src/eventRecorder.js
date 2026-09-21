import { appendFileSync } from "node:fs"

export function recordEvent(event) {
	appendFileSync("events.ndjson", `${JSON.stringify(event)}\n`)
}
