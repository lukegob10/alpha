import type { TicketOverview } from "@alpha-code/types"

type ProgressPoint = TicketOverview["points"][number]
type Coordinate = { x: number; y: number }

/** Shared smoothstep weights prevent overshoot and keep completed below scope between observations. */
export function smoothProgressPath(points: readonly Coordinate[]): string {
	if (!points.length) return ""
	let path = `M ${points[0].x} ${points[0].y}`
	for (let index = 1; index < points.length; index++) {
		const previous = points[index - 1]
		const point = points[index]
		const third = (point.x - previous.x) / 3
		path += ` C ${previous.x + third} ${previous.y}, ${point.x - third} ${point.y}, ${point.x} ${point.y}`
	}
	return path
}

function datePosition(date: string): number {
	return Date.parse(`${date}T00:00:00.000Z`)
}

/** Dates retain their elapsed spacing when no observation was recorded on an intervening day. */
export function progressX(points: readonly ProgressPoint[], date: string, left: number, width: number): number {
	if (points.length <= 1) return left + width / 2
	const start = datePosition(points[0].date)
	const duration = datePosition(points[points.length - 1].date) - start
	return duration > 0 ? left + ((datePosition(date) - start) / duration) * width : left + width / 2
}

export function nearestProgressPoint(points: readonly ProgressPoint[], fraction: number): number {
	if (points.length <= 1) return 0
	const first = datePosition(points[0].date)
	const target = first + (datePosition(points[points.length - 1].date) - first) * fraction
	let best = 0
	for (let index = 1; index < points.length; index++) {
		if (Math.abs(datePosition(points[index].date) - target) < Math.abs(datePosition(points[best].date) - target))
			best = index
	}
	return best
}

export function progressTicks(points: readonly ProgressPoint[], maximum: number): number[] {
	if (!points.length) return []
	if (points.length === 1) return [0]
	const ticks = [0]
	const first = datePosition(points[0].date)
	const duration = datePosition(points[points.length - 1].date) - first
	const minimumGap = (duration / Math.max(1, maximum - 1)) * 0.6
	for (let index = 1; index < maximum - 1; index++) {
		const next = nearestProgressPoint(points, index / (maximum - 1))
		if (
			datePosition(points[next].date) - datePosition(points[ticks[ticks.length - 1]].date) >= minimumGap &&
			datePosition(points[points.length - 1].date) - datePosition(points[next].date) >= minimumGap
		)
			ticks.push(next)
	}
	ticks.push(points.length - 1)
	return ticks
}
