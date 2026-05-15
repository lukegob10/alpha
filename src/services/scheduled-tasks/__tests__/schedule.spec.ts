import type { ScheduledTaskSchedule } from "@alpha-code/types"

import { getNextRunAt } from "../schedule"

describe("scheduled task schedule calculation", () => {
	it("returns a one-time run only when it is in the future", () => {
		const schedule: ScheduledTaskSchedule = { type: "once", startAt: 2_000, timezone: "UTC" }

		expect(getNextRunAt(schedule, 1_000)).toBe(2_000)
		expect(getNextRunAt(schedule, 2_000)).toBeUndefined()
	})

	it("advances hourly schedules past the provided time", () => {
		const schedule: ScheduledTaskSchedule = {
			type: "hourly",
			startAt: 1_000,
			timezone: "UTC",
			intervalHours: 1,
		}

		expect(getNextRunAt(schedule, 1_000)).toBe(3_601_000)
		expect(getNextRunAt(schedule, 3_601_000)).toBe(7_201_000)
	})

	it("advances recurring missed runs to the next future occurrence", () => {
		const schedule: ScheduledTaskSchedule = {
			type: "daily",
			startAt: 1_000,
			timezone: "America/New_York",
			intervalDays: 1,
		}

		expect(getNextRunAt(schedule, 3 * 24 * 60 * 60 * 1000)).toBe(259_201_000)
	})

	it("clamps monthly schedules to valid target-month days", () => {
		const schedule: ScheduledTaskSchedule = {
			type: "monthly",
			startAt: new Date("2026-01-31T12:00:00.000Z").getTime(),
			timezone: "UTC",
			intervalMonths: 1,
		}

		expect(new Date(getNextRunAt(schedule, new Date("2026-02-01T00:00:00.000Z").getTime())!).toISOString()).toBe(
			"2026-02-28T12:00:00.000Z",
		)
	})
})
