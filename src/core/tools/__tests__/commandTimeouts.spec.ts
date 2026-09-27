import { describe, expect, it } from "vitest"

import {
	EXEC_COMMAND_DEFAULT_YIELD_TIME_MS,
	EXEC_COMMAND_MAX_YIELD_TIME_MS,
	EXEC_COMMAND_MIN_YIELD_TIME_MS,
	EXEC_COMMAND_WINDOWS_YIELD_TIME_FLOOR_MS,
	getExecCommandYieldTimeBounds,
	normalizeExecCommandYieldTimeMs,
} from "../commandTimeouts"

describe("exec_command yield timing", () => {
	const bounds = getExecCommandYieldTimeBounds()

	it("uses a 10 second default", () => {
		expect(normalizeExecCommandYieldTimeMs(undefined)).toBe(EXEC_COMMAND_DEFAULT_YIELD_TIME_MS)
		expect(normalizeExecCommandYieldTimeMs(null)).toBe(EXEC_COMMAND_DEFAULT_YIELD_TIME_MS)
	})

	it("clamps short waits to the platform minimum", () => {
		const minimum =
			process.platform === "win32" ? EXEC_COMMAND_WINDOWS_YIELD_TIME_FLOOR_MS : EXEC_COMMAND_MIN_YIELD_TIME_MS
		expect(bounds.minimum).toBe(minimum)
		expect(normalizeExecCommandYieldTimeMs(0)).toBe(minimum)
		expect(normalizeExecCommandYieldTimeMs(1)).toBe(minimum)
	})

	it("caps long waits at 30 seconds", () => {
		expect(bounds.maximum).toBe(EXEC_COMMAND_MAX_YIELD_TIME_MS)
		expect(normalizeExecCommandYieldTimeMs(300_001)).toBe(EXEC_COMMAND_MAX_YIELD_TIME_MS)
	})

	it("preserves valid waits within the supported range", () => {
		const inRange = Math.max(bounds.minimum, 15_000)
		expect(normalizeExecCommandYieldTimeMs(inRange)).toBe(inRange)
	})

	it("defaults malformed values instead of passing them to the command timer", () => {
		for (const malformed of ["1000", 1000.5, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
			expect(normalizeExecCommandYieldTimeMs(malformed)).toBe(EXEC_COMMAND_DEFAULT_YIELD_TIME_MS)
		}
	})
})
