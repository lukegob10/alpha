/** A verified native route refused this capability; its existing local summarizer may recover. */
export class NativeCompactionUnavailableError extends Error {
	override readonly name = "NativeCompactionUnavailableError"
	constructor() {
		super("Native compaction is unavailable for this route or model")
	}
}

/** The response completed and was accounted, but its window cannot safely replace context. */
export class NativeCompactionInvalidResultError extends Error {
	override readonly name = "NativeCompactionInvalidResultError"
	constructor() {
		super("Invalid native compaction checkpoint")
	}
}
