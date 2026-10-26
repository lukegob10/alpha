import type { ScheduledTaskSchedule } from "@alpha-code/types"

export const isRecurringSchedule = (schedule: ScheduledTaskSchedule): boolean => schedule.type !== "once"

const DAY_MS = 24 * 60 * 60 * 1000
type CalendarSchedule = Extract<ScheduledTaskSchedule, { type: "daily" | "weekly" | "monthly" }>

const calendarTimes = (timezone: string) => {
	const formatter = new Intl.DateTimeFormat("en-US", {
		timeZone: timezone,
		calendar: "gregory",
		numberingSystem: "latn",
		era: "short",
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23",
	})
	// UTC fields encode civil time in the saved zone; host-local Date setters are never used.
	const localTimeAt = (instant: number): number => {
		if (!Number.isFinite(new Date(instant).getTime())) return NaN
		const parts = Object.fromEntries(formatter.formatToParts(instant).map((part) => [part.type, part.value]))
		const year = parts.era === "BC" ? 1 - Number(parts.year) : Number(parts.year)
		const date = new Date(0)
		date.setUTCFullYear(year, Number(parts.month) - 1, Number(parts.day))
		date.setUTCHours(
			Number(parts.hour),
			Number(parts.minute),
			Number(parts.second),
			new Date(instant).getUTCMilliseconds(),
		)
		return date.getTime()
	}
	const instantAt = (localTime: number): number => {
		// Nearby offsets cover both sides of DST and date-line transitions. Match ECMA-262
		// Date disambiguation (retrieved 2026-10-26): first repeated instant, forward across a gap.
		const offsets = new Set(
			[-2, 0, 2].map((days) => {
				const probe = localTime + days * DAY_MS
				return localTimeAt(probe) - probe
			}),
		)
		const candidates = [...offsets].map((offset) => {
			const instant = localTime - offset
			return { instant, localTime: localTimeAt(instant) }
		})
		const exact = candidates.filter((candidate) => candidate.localTime === localTime)
		if (exact.length) return Math.min(...exact.map((candidate) => candidate.instant))
		return (
			candidates
				.filter((candidate) => candidate.localTime > localTime)
				.sort((a, b) => a.localTime - b.localTime || a.instant - b.instant)[0]?.instant ?? NaN
		)
	}
	return { localTimeAt, instantAt }
}

const nextCalendarRun = (schedule: CalendarSchedule, after: number): number | undefined => {
	const interval =
		schedule.type === "monthly"
			? schedule.intervalMonths
			: schedule.type === "daily"
				? schedule.intervalDays
				: schedule.intervalWeeks
	if (!Number.isSafeInteger(interval) || interval <= 0) return undefined
	const { localTimeAt, instantAt } = calendarTimes(schedule.timezone)
	if (schedule.startAt > after) return schedule.startAt
	const start = localTimeAt(schedule.startAt)
	const current = localTimeAt(after)
	const startDate = new Date(start)
	const currentDate = new Date(current)
	const monthsElapsed =
		(currentDate.getUTCFullYear() - startDate.getUTCFullYear()) * 12 +
		currentDate.getUTCMonth() -
		startDate.getUTCMonth()
	const intervalMs = interval * DAY_MS * (schedule.type === "weekly" ? 7 : 1)
	let occurrence = Math.max(
		1,
		Math.floor(schedule.type === "monthly" ? monthsElapsed / interval : (current - start) / intervalMs),
	)
	// The calendar estimate needs at most a neighboring occurrence around an overlap or skipped day.
	for (let adjustment = 0; adjustment < 3; adjustment++, occurrence++) {
		const date = new Date(start)
		if (schedule.type === "monthly") {
			date.setUTCDate(1)
			date.setUTCMonth(date.getUTCMonth() + occurrence * interval)
			const monthEnd = new Date(date)
			monthEnd.setUTCMonth(monthEnd.getUTCMonth() + 1, 0)
			date.setUTCDate(Math.min(startDate.getUTCDate(), monthEnd.getUTCDate()))
		} else {
			date.setTime(start + occurrence * intervalMs)
		}
		if (!Number.isFinite(date.getTime())) return undefined
		const next = instantAt(date.getTime())
		if (next > after) return next
	}
	return undefined
}

export const getNextRunAt = (schedule: ScheduledTaskSchedule, after: number): number | undefined => {
	if (!Number.isFinite(new Date(schedule.startAt).getTime()) || !Number.isFinite(new Date(after).getTime())) {
		return undefined
	}
	if (schedule.type === "once") {
		return schedule.startAt > after ? schedule.startAt : undefined
	}

	let next: number
	if (schedule.type === "monthly" || schedule.type === "daily" || schedule.type === "weekly") {
		const calendarRun = nextCalendarRun(schedule, after)
		if (calendarRun === undefined) return undefined
		next = calendarRun
	} else {
		const intervalMs = schedule.type === "hourly" ? schedule.intervalHours * 60 * 60 * 1000 : schedule.intervalMs
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
			return undefined
		}
		const elapsed = after - schedule.startAt
		const intervalsToAdvance = elapsed >= 0 ? Math.floor(elapsed / intervalMs) + 1 : 0
		next = schedule.startAt + intervalsToAdvance * intervalMs
		if (!Number.isFinite(next) || next <= after) {
			return undefined
		}
	}

	if ("endAt" in schedule && schedule.endAt !== undefined && next > schedule.endAt) {
		return undefined
	}

	return next
}
