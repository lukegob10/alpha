import { describe, expect, it } from "vitest"
import { parentVerificationObligationSchema } from "../subagent.js"
import { isLegacyReadFileParams } from "../tool-params.js"

describe("primary observation compatibility", () => {
	const base = {
		id: "primary-change:root",
		changeSetId: "primary-change:root",
		rootTaskId: "root",
		parentTaskId: "root",
		workerTaskId: "root",
		workerNickname: "Primary",
		groupId: "root",
		origin: "primary",
		changedFiles: [],
		status: "pending",
		createdAt: 1,
		updatedAt: 2,
		appliedAt: 1,
	}
	it("reads old reservations and completed incomplete observations without accepting unexplained empty changes", () => {
		expect(
			parentVerificationObligationSchema.safeParse({ ...base, mutationReservations: ["running"] }).success,
		).toBe(true)
		expect(parentVerificationObligationSchema.safeParse({ ...base, observationIncomplete: true }).success).toBe(
			true,
		)
		expect(parentVerificationObligationSchema.safeParse(base).success).toBe(false)
		expect(
			parentVerificationObligationSchema.safeParse({ ...base, origin: "worker", observationIncomplete: true })
				.success,
		).toBe(false)
	})
	it("recognizes both public batches and saved parser batches", () => {
		expect(
			isLegacyReadFileParams({ files: [{ path: "a" }, { path: "b", line_ranges: [{ start: 2, end: 3 }] }] }),
		).toBe(true)
		expect(
			isLegacyReadFileParams({ files: [{ path: "a", lineRanges: [{ start: 1, end: 2 }] }], _legacyFormat: true }),
		).toBe(true)
		expect(isLegacyReadFileParams({ path: "a" })).toBe(false)
	})
})
