import type { ScheduledTaskSchedule } from "@roo-code/types"

export const isRecurringSchedule = (schedule: ScheduledTaskSchedule): boolean => schedule.type !== "once"

const addMonthsClamped = (date: Date, months: number): Date => {
	const next = new Date(date)
	const day = next.getDate()
	next.setDate(1)
	next.setMonth(next.getMonth() + months)
	const daysInTargetMonth = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate()
	next.setDate(Math.min(day, daysInTargetMonth))
	return next
}

const addInterval = (schedule: ScheduledTaskSchedule, from: number): number => {
	switch (schedule.type) {
		case "once":
			return schedule.startAt
		case "hourly":
			return from + schedule.intervalHours * 60 * 60 * 1000
		case "daily":
			return from + schedule.intervalDays * 24 * 60 * 60 * 1000
		case "weekly":
			return from + schedule.intervalWeeks * 7 * 24 * 60 * 60 * 1000
		case "monthly":
			return addMonthsClamped(new Date(from), schedule.intervalMonths).getTime()
		case "customInterval":
			return from + schedule.intervalMs
		default:
			throw new Error(`Unsupported schedule type: ${(schedule as { type: string }).type}`)
	}
}

export const getNextRunAt = (schedule: ScheduledTaskSchedule, after: number): number | undefined => {
	if (schedule.type === "once") {
		return schedule.startAt > after ? schedule.startAt : undefined
	}

	let next = schedule.startAt
	let guard = 0

	while (next <= after && guard < 10000) {
		next = addInterval(schedule, next)
		guard += 1
	}

	if ("endAt" in schedule && schedule.endAt !== undefined && next > schedule.endAt) {
		return undefined
	}

	return next
}

export const formatScheduleForPrompt = (schedule: ScheduledTaskSchedule): string => {
	const start = new Date(schedule.startAt).toISOString()
	switch (schedule.type) {
		case "once":
			return `once at ${start} (${schedule.timezone})`
		case "hourly":
			return `every ${schedule.intervalHours} hour(s), starting ${start} (${schedule.timezone})`
		case "daily":
			return `every ${schedule.intervalDays} day(s), starting ${start} (${schedule.timezone})`
		case "weekly":
			return `every ${schedule.intervalWeeks} week(s), starting ${start} (${schedule.timezone})`
		case "monthly":
			return `every ${schedule.intervalMonths} month(s), starting ${start} (${schedule.timezone})`
		case "customInterval":
			return `every ${schedule.intervalMs} ms, starting ${start} (${schedule.timezone})`
		default:
			throw new Error(`Unsupported schedule type: ${(schedule as { type: string }).type}`)
	}
}
