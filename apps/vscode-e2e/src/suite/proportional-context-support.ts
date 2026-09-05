/** Execute every owned cleanup, keeping the original failure first if cleanup also fails. */
export async function withFixtureCleanup<T>(
	operation: () => Promise<T>,
	cleanups: readonly (() => unknown | Promise<unknown>)[],
): Promise<T> {
	let outcome: { ok: true; value: T } | { ok: false; error: unknown }
	try {
		outcome = { ok: true, value: await operation() }
	} catch (error) {
		outcome = { ok: false, error }
	}
	const failures: unknown[] = []
	for (const cleanup of cleanups) {
		try {
			await cleanup()
		} catch (error) {
			failures.push(error)
		}
	}
	if (!outcome.ok) {
		if (failures.length) {
			throw new AggregateError([outcome.error, ...failures], "Fixture and cleanup failed", {
				cause: outcome.error,
			})
		}
		throw outcome.error
	}
	if (failures.length) throw new AggregateError(failures, "Fixture cleanup failed")
	return outcome.value
}

type CleanupDeadlineScheduler = (timeout: () => void, milliseconds: number) => () => void
const scheduleCleanupDeadline: CleanupDeadlineScheduler = (timeout, milliseconds) => {
	const timer = setTimeout(timeout, milliseconds)
	return () => clearTimeout(timer)
}

/** A stuck cleanup cannot prevent cancellation, method restoration, or subsequent cleanup attempts. */
export async function withBoundedFixtureCleanup<T>(
	operation: () => Promise<T>,
	cleanups: readonly (() => unknown | Promise<unknown>)[],
	scheduleDeadline: CleanupDeadlineScheduler = scheduleCleanupDeadline,
): Promise<T> {
	return withFixtureCleanup(
		operation,
		cleanups.map((cleanup, index) => async () => {
			let cancelDeadline: (() => void) | undefined
			const deadline = new Promise<never>((_resolve, reject) => {
				cancelDeadline = scheduleDeadline(
					() => reject(new Error(`Fixture cleanup ${index + 1} did not settle within 5000 ms`)),
					5000,
				)
			})
			try {
				// Promise.race retains rejection handlers for a cleanup that fails after its deadline.
				return await Promise.race([Promise.resolve().then(cleanup), deadline])
			} finally {
				cancelDeadline?.()
			}
		}),
	)
}

/** Acknowledge only the on-screen final review, once; recovery and tool approvals remain untouched. */
export function createCompletionReviewAcknowledger() {
	let acknowledged = false
	return (
		task:
			| {
					didComplete?: boolean
					abort?: boolean
					taskAsk?: { ask?: string }
					approveAsk(): void
			  }
			| undefined,
	): boolean => {
		if (acknowledged || !task || task.didComplete || task.abort || task.taskAsk?.ask !== "completion_result") {
			return false
		}
		acknowledged = true
		task.approveAsk()
		return true
	}
}

/** Runner-supplied provenance is a declaration, not proof that the checkout produced the loaded bundle. */
export function parseContextRunMetadata(raw: string | undefined) {
	if (!raw) throw new Error("ALPHA_SCOPE_RUN_METADATA must declare source, build, configuration, and cache state")
	const value: unknown = JSON.parse(raw)
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid context run metadata")
	const input = value as Record<string, unknown>
	const hash = (field: string, length: number): string => {
		const candidate = input[field]
		if (typeof candidate !== "string" || !new RegExp(`^[a-f0-9]{${length}}$`).test(candidate)) {
			throw new Error(`Invalid context run metadata: ${field}`)
		}
		return candidate
	}
	const sourceRevision = hash("sourceRevision", 40)
	const buildSha256 = hash("buildSha256", 64)
	if (input.sourceTreeState !== "clean" && input.sourceTreeState !== "modified") {
		throw new Error("Invalid context run metadata: sourceTreeState")
	}
	const sourceDiffSha256 = input.sourceTreeState === "modified" ? hash("sourceDiffSha256", 64) : null
	if (typeof input.configurationId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.configurationId)) {
		throw new Error("Invalid context run metadata: configurationId")
	}
	if (input.hostAtSuiteStart !== "fresh" && input.hostAtSuiteStart !== "reused") {
		throw new Error("Invalid context run metadata: hostAtSuiteStart")
	}
	return {
		provenanceSource: "runner-declared",
		sourceRevision,
		sourceTreeState: input.sourceTreeState,
		sourceDiffSha256,
		buildSha256,
		configurationId: input.configurationId,
		cacheState: {
			hostAtSuiteStart: input.hostAtSuiteStart,
			sampling: "fresh tasks in one host shared across scenarios and samples",
			providerPromptCache: "disabled",
		},
	}
}
