import { execFileSync } from "node:child_process"
import * as path from "node:path"
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

	it("advances fixed intervals beyond the former iteration limit", () => {
		const schedule: ScheduledTaskSchedule = {
			type: "customInterval",
			startAt: 0,
			timezone: "UTC",
			intervalMs: 1,
		}

		expect(getNextRunAt(schedule, 20_000)).toBe(20_001)
	})

	it("honors endAt after advancing many fixed intervals", () => {
		const schedule: ScheduledTaskSchedule = {
			type: "customInterval",
			startAt: 0,
			endAt: 20_000,
			timezone: "UTC",
			intervalMs: 1,
		}

		expect(getNextRunAt(schedule, 20_000)).toBeUndefined()
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

	it.each(["UTC", "America/New_York", "Pacific/Auckland"])(
		"uses the saved timezone when the extension host uses %s",
		(hostTimezone) => {
			const script = [
				"const { getNextRunAt } = require(process.argv[1])",
				"const schedule = JSON.parse(process.argv[2])",
				"process.stdout.write(new Date(getNextRunAt(schedule, Date.parse('2026-03-01T00:00:00Z'))).toISOString())",
			].join("\n")
			const schedule: ScheduledTaskSchedule = {
				type: "monthly",
				startAt: Date.parse("2026-01-15T12:00:00Z"),
				timezone: "UTC",
				intervalMonths: 1,
			}
			const output = execFileSync(
				process.execPath,
				["-e", script, path.resolve(__dirname, "../schedule.ts"), JSON.stringify(schedule)],
				{ env: { ...process.env, TZ: hostTimezone }, encoding: "utf8" },
			)
			expect(output).toBe("2026-03-15T12:00:00.000Z")
		},
	)

	it.each([
		["daily", "2026-03-07T14:00:00Z", "2026-03-08T13:00:00.000Z"],
		["daily", "2026-10-31T13:00:00Z", "2026-11-01T14:00:00.000Z"],
		["weekly", "2026-03-01T14:00:00Z", "2026-03-08T13:00:00.000Z"],
		["weekly", "2026-10-25T13:00:00Z", "2026-11-01T14:00:00.000Z"],
	] as const)("keeps %s wall-clock time across the DST transition after %s", (type, start, expected) => {
		const schedule: ScheduledTaskSchedule = {
			...(type === "daily" ? { type, intervalDays: 1 } : { type, intervalWeeks: 1 }),
			startAt: Date.parse(start),
			timezone: "America/New_York",
		}
		expect(new Date(getNextRunAt(schedule, schedule.startAt)!).toISOString()).toBe(expected)
	})

	it("moves a nonexistent local time forward across the gap without changing later occurrences", () => {
		const schedule: ScheduledTaskSchedule = {
			type: "daily",
			startAt: Date.parse("2026-03-07T07:30:00Z"),
			timezone: "America/New_York",
			intervalDays: 1,
		}
		const gapRun = getNextRunAt(schedule, schedule.startAt)!
		expect(new Date(gapRun).toISOString()).toBe("2026-03-08T07:30:00.000Z")
		expect(new Date(getNextRunAt(schedule, gapRun)!).toISOString()).toBe("2026-03-09T06:30:00.000Z")
	})

	it("chooses the first repeated local time and schedules only one occurrence that day", () => {
		const schedule: ScheduledTaskSchedule = {
			type: "daily",
			startAt: Date.parse("2026-10-31T05:30:00Z"),
			timezone: "America/New_York",
			intervalDays: 1,
		}
		const overlapRun = getNextRunAt(schedule, schedule.startAt)!
		expect(new Date(overlapRun).toISOString()).toBe("2026-11-01T05:30:00.000Z")
		expect(new Date(getNextRunAt(schedule, overlapRun)!).toISOString()).toBe("2026-11-02T06:30:00.000Z")
	})

	it.each([
		["Australia/Lord_Howe", "2026-10-02T15:45:00Z", "2026-10-03T15:45:00.000Z", "2026-10-04T15:15:00.000Z"],
		["Pacific/Apia", "2011-12-29T19:00:00Z", "2011-12-30T19:00:00.000Z", "2011-12-31T19:00:00.000Z"],
	])("handles non-hour gaps in %s without repeating an occurrence", (timezone, start, first, second) => {
		const schedule: ScheduledTaskSchedule = {
			type: "daily",
			startAt: Date.parse(start),
			timezone,
			intervalDays: 1,
		}
		const firstRun = getNextRunAt(schedule, schedule.startAt)!
		expect(new Date(firstRun).toISOString()).toBe(first)
		expect(new Date(getNextRunAt(schedule, firstRun)!).toISOString()).toBe(second)
	})

	it.each([
		["2026-01-31T12:00:00Z", 1, "2026-03-01T00:00:00Z", "2026-03-31T12:00:00.000Z"],
		["2026-01-31T12:00:00Z", 1, "2026-04-01T00:00:00Z", "2026-04-30T12:00:00.000Z"],
		["2028-01-31T12:00:00Z", 1, "2028-02-01T00:00:00Z", "2028-02-29T12:00:00.000Z"],
		["2026-01-31T12:00:00Z", 3, "2026-05-01T00:00:00Z", "2026-07-31T12:00:00.000Z"],
	])("retains the original monthly day after clamping from %s", (start, intervalMonths, after, expected) => {
		const schedule: ScheduledTaskSchedule = {
			type: "monthly",
			startAt: Date.parse(start),
			timezone: "UTC",
			intervalMonths,
		}
		expect(new Date(getNextRunAt(schedule, Date.parse(after))!).toISOString()).toBe(expected)
	})

	it("honors a calendar schedule's deadline after timezone conversion", () => {
		const schedule: ScheduledTaskSchedule = {
			type: "daily",
			startAt: Date.parse("2026-03-07T14:00:00Z"),
			timezone: "America/New_York",
			intervalDays: 1,
			endAt: Date.parse("2026-03-08T13:00:00Z"),
		}
		expect(getNextRunAt(schedule, schedule.startAt)).toBe(schedule.endAt)
		expect(getNextRunAt(schedule, schedule.endAt!)).toBeUndefined()
	})
})
