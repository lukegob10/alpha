import { canonicalJson, sha256 } from "./canonical"
import { redact, type RedactionOptions } from "./redaction"
import { EVIDENCE_SCHEMA_VERSION, REDACTION_VERSION, type EvalEvent } from "./types"

export type EventJournalIdentity = Pick<EvalEvent, "runId" | "trialId" | "attemptId">

export class EventJournal {
	private readonly events: EvalEvent[] = []

	constructor(
		private readonly identity: EventJournalIdentity,
		private readonly redaction: RedactionOptions = {},
	) {}

	append(type: string, payload: unknown, timestamp = new Date().toISOString(), late = false): EvalEvent {
		const normalizedPayload = redact(payload, this.redaction)
		const event: EvalEvent = {
			schemaVersion: EVIDENCE_SCHEMA_VERSION,
			...this.identity,
			sequence: this.events.length + 1,
			timestamp,
			type,
			payload: normalizedPayload,
			payloadDigest: sha256(canonicalJson(normalizedPayload)),
			redactionVersion: REDACTION_VERSION,
			late,
		}
		this.events.push(event)
		return structuredClone(event)
	}

	all(): EvalEvent[] {
		return structuredClone(this.events)
	}
}
