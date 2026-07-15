import type { EventJournal } from "./eventJournal"
import type { EvalEvent } from "./types"

export type EventPayloadValidator = (payload: unknown) => boolean

export class EvalEventRegistry {
	private readonly validators = new Map<string, EventPayloadValidator>()

	register(type: string, validator: EventPayloadValidator): this {
		if (this.validators.has(type)) throw new Error(`Event type ${type} is already registered`)
		this.validators.set(type, validator)
		return this
	}

	normalize(journal: EventJournal, type: string, payload: unknown, timestamp?: string): EvalEvent {
		const validator = this.validators.get(type)
		if (!validator) throw new Error(`Unknown eval event type ${type}`)
		if (!validator(payload)) throw new Error(`Invalid payload for eval event type ${type}`)
		return journal.append(type, payload, timestamp)
	}
}

export function createRuntimeEventRegistry(): EvalEventRegistry {
	const objectPayload: EventPayloadValidator = (payload) => !!payload && typeof payload === "object"
	return new EvalEventRegistry()
		.register("agent.turn", objectPayload)
		.register("agent.step_context", objectPayload)
		.register("tool.policy", objectPayload)
		.register("tool.call", objectPayload)
		.register("compaction", objectPayload)
		.register("verification", objectPayload)
		.register("lifecycle.observation", objectPayload)
}
