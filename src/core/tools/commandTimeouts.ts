/** Maximum time a managed command wait may block a model step. */
export const MANAGE_COMMAND_MAX_TIMEOUT_MS = 300_000

export const EXEC_COMMAND_DEFAULT_YIELD_TIME_MS = 10_000
export const EXEC_COMMAND_MIN_YIELD_TIME_MS = 250
export const EXEC_COMMAND_WINDOWS_YIELD_TIME_FLOOR_MS = 10_000
export const EXEC_COMMAND_MAX_YIELD_TIME_MS = 30_000

export function getExecCommandYieldTimeBounds(): { minimum: number; maximum: number } {
	return {
		minimum:
			process.platform === "win32" ? EXEC_COMMAND_WINDOWS_YIELD_TIME_FLOOR_MS : EXEC_COMMAND_MIN_YIELD_TIME_MS,
		maximum: EXEC_COMMAND_MAX_YIELD_TIME_MS,
	}
}

/** Match the exec_command initial wait contract while keeping malformed model values bounded. */
export function normalizeExecCommandYieldTimeMs(value: unknown): number {
	const requested =
		typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
			? value
			: EXEC_COMMAND_DEFAULT_YIELD_TIME_MS
	const { minimum, maximum } = getExecCommandYieldTimeBounds()
	return Math.min(maximum, Math.max(minimum, requested))
}
