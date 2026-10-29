import {
	ElicitRequestSchema,
	ElicitResultSchema,
	type ElicitRequest,
	type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"

export interface McpElicitationOwner {
	signal: AbortSignal
	ask(message: string, schema: object, signal: AbortSignal): Promise<string | undefined>
}

/** Connections are shared; ambiguous or unsolicited requests must never select the foreground task. */
export class McpElicitationRouter {
	private readonly owners = new Set<McpElicitationOwner>()
	private pending = false

	async run<T>(owner: McpElicitationOwner, dispatch: () => Promise<T>): Promise<T> {
		const lifetime = new AbortController()
		const scoped = { ...owner, signal: AbortSignal.any([owner.signal, lifetime.signal]) }
		this.owners.add(scoped)
		try {
			return await dispatch()
		} finally {
			this.owners.delete(scoped)
			lifetime.abort()
		}
	}

	async handle(raw: ElicitRequest, requestSignal: AbortSignal): Promise<ElicitResult> {
		const parsed = ElicitRequestSchema.safeParse(raw)
		if (!parsed.success || parsed.data.params.mode === "url" || this.owners.size !== 1 || this.pending)
			return { action: "cancel" }
		const owner = this.owners.values().next().value!
		const { message, requestedSchema } = parsed.data.params
		if (
			message.length > 8_000 ||
			JSON.stringify(requestedSchema).length > 16_000 ||
			Object.keys(requestedSchema.properties).length > 24
		)
			return { action: "decline" }
		const deadline = new AbortController()
		this.pending = true
		const timer = setTimeout(() => deadline.abort(), 60_000)
		const signal = AbortSignal.any([owner.signal, requestSignal, deadline.signal])
		let onAbort!: () => void
		try {
			signal.throwIfAborted()
			const validate = new AjvJsonSchemaValidator().getValidator({
				...requestedSchema,
				additionalProperties: false,
			})
			const cancelled = new Promise<undefined>((resolve) => {
				onAbort = () => resolve(undefined)
				signal.addEventListener("abort", onAbort, { once: true })
				if (signal.aborted) onAbort()
			})
			const answer = await Promise.race([owner.ask(message, requestedSchema, signal), cancelled])
			if (signal.aborted || !this.owners.has(owner) || answer === undefined) return { action: "cancel" }
			if (answer.length > 16_000) return { action: "decline" }
			const content: unknown = JSON.parse(answer)
			if (!validate(content).valid) return { action: "decline" }
			return ElicitResultSchema.parse({ action: "accept", content })
		} catch {
			return { action: signal.aborted ? "cancel" : "decline" }
		} finally {
			this.pending = false
			clearTimeout(timer)
			if (onAbort) signal.removeEventListener("abort", onAbort)
		}
	}
}
