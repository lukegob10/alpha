import { createHash } from "crypto"

export interface EnvironmentField {
	name: string
	value: string
	/** Volatile display text may change without invalidating the field. */
	comparison?: string
}

export interface EnvironmentReceipt {
	commit(): void
	release?(): void
}

export interface EnvironmentCapture {
	readonly details: string
	commit(): void
	release(): void
}

export interface TerminalOutputCursor {
	terminalId: number
	processIndex: number
}

const fingerprint = (value: string) => createHash("sha256").update(value).digest("hex")

/** One committed baseline per Task instance; no transcript or output buffer is retained here. */
export class EnvironmentContext {
	private identity?: string
	private fields = new Map<string, string>()
	private revision = 0
	private outputCursor?: TerminalOutputCursor
	private outputRevision = 0

	get terminalOutputCursor(): Readonly<TerminalOutputCursor> | undefined {
		return this.outputCursor
	}

	get needsFullSnapshot(): boolean {
		return this.identity === undefined
	}

	requiresFullSnapshot(identity: string): boolean {
		return this.identity !== fingerprint(identity)
	}

	reset(): void {
		this.identity = undefined
		this.fields.clear()
		this.revision++
	}

	prepare(
		identity: string,
		fields: readonly EnvironmentField[],
		transientDetails: string,
		receipts: readonly EnvironmentReceipt[],
		retainedFields: readonly string[] = [],
		outputCursor?: TerminalOutputCursor,
	): EnvironmentCapture {
		const full = this.requiresFullSnapshot(identity)
		const revision = this.revision
		const outputRevision = this.outputRevision
		const nextFields = new Map(
			fields.map(({ name, value, comparison }) => [name, fingerprint(comparison ?? value)]),
		)
		if (!full) {
			for (const name of retainedFields) {
				const previous = this.fields.get(name)
				if (previous && !nextFields.has(name)) nextFields.set(name, previous)
			}
		}
		const changed = fields.filter(({ name }) => full || nextFields.get(name) !== this.fields.get(name))
		const removed = full ? [] : [...this.fields.keys()].filter((name) => !nextFields.has(name))
		const hasChanges = changed.length > 0 || removed.length > 0 || transientDetails.length > 0
		const clock = fields.find(({ name }) => name === "Current Time")
		if (hasChanges && clock && !changed.includes(clock)) changed.push(clock)
		const sections = changed.map(({ name, value }) => `# ${name}\n${value}`)
		sections.push(...removed.map((name) => `# ${name}\n(none; previous value no longer applies)`))
		if (transientDetails) sections.push(transientDetails)
		const details = hasChanges
			? `<environment_details>\n${full ? "# Environment Snapshot" : "# Environment Changes"}\n${sections.join("\n\n")}\n</environment_details>`
			: ""
		let settled = false
		return {
			details,
			commit: () => {
				if (settled) return
				settled = true
				// A save can finish during cancellation. Once durable, acknowledge its
				// captured events even when a reset has invalidated this baseline.
				for (const receipt of receipts) receipt.commit()
				// Compaction invalidates facts, but must not restart fair output delivery.
				if (outputCursor && this.outputRevision === outputRevision) {
					this.outputCursor = outputCursor
					this.outputRevision++
				}
				if (this.revision === revision) {
					this.identity = fingerprint(identity)
					this.fields = nextFields
					this.revision++
				}
			},
			release: () => {
				if (settled) return
				settled = true
				for (const receipt of receipts) receipt.release?.()
			},
		}
	}
}

/** Race host reads without leaking an abort listener or an unhandled late rejection. */
export function awaitEnvironmentRead<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return operation
	return new Promise<T>((resolve, reject) => {
		const abort = () => {
			signal.removeEventListener("abort", abort)
			reject(signal.reason ?? new Error("Environment collection cancelled"))
		}
		if (signal.aborted) abort()
		else signal.addEventListener("abort", abort, { once: true })
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort)
				if (signal.aborted) abort()
				else resolve(value)
			},
			(error) => {
				signal.removeEventListener("abort", abort)
				reject(error)
			},
		)
	})
}
