export interface ResponseObservation {
	request: number
	toolCount: number
	parts: Record<string, number>
	textCharacters: number
	ended: boolean
}

/** Counts response shapes only; never retains prompts, output text, or opaque provider state. */
export class LiveResponseProbe {
	readonly observations: ResponseObservation[] = []

	wrap(response: unknown, request: number, toolCount: number): unknown {
		if (!response || typeof response !== "object" || !("stream" in response)) return response
		const source = response.stream as AsyncIterable<unknown>
		const observation: ResponseObservation = { request, toolCount, parts: {}, textCharacters: 0, ended: false }
		this.observations.push(observation)
		const stream = (async function* () {
			for await (const part of source) {
				const object = part !== null && typeof part === "object" ? (part as Record<string, unknown>) : undefined
				const kind =
					typeof part === "string"
						? "string"
						: object
							? Object.keys(object).sort().slice(0, 8).join(",").slice(0, 120)
							: typeof part
				if (Object.hasOwn(observation.parts, kind) || Object.keys(observation.parts).length < 20)
					observation.parts[kind] = (observation.parts[kind] ?? 0) + 1
				observation.textCharacters +=
					typeof part === "string" ? part.length : typeof object?.value === "string" ? object.value.length : 0
				yield part
			}
			observation.ended = true
		})()
		return new Proxy(Object.create(response) as object, {
			get(_target, key) {
				if (key === "stream") return stream
				const value: unknown = Reflect.get(response, key, response)
				return typeof value === "function" ? value.bind(response) : value
			},
		})
	}
}
