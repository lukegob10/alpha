import { describe, expect, it } from "vitest"
import { nearestProgressPoint, progressTicks, progressX, smoothProgressPath } from "../ticketProgressChart"

const points = [
	{ date: "2026-10-01", total: 20, complete: 0 },
	{ date: "2026-10-02", total: 24, complete: 5 },
	{ date: "2026-10-11", total: 30, complete: 18 },
]

function sampleRenderedCurve(from: number, to: number, t: number): number {
	const path = smoothProgressPath([
		{ x: 0, y: from },
		{ x: 100, y: to },
	])
	const coordinates = path.match(/-?\d+(?:\.\d+)?/g)!.map(Number)
	const [start, controlOne, controlTwo, end] = [coordinates[1], coordinates[3], coordinates[5], coordinates[7]]
	return (1 - t) ** 3 * start + 3 * (1 - t) ** 2 * t * controlOne + 3 * (1 - t) * t ** 2 * controlTwo + t ** 3 * end
}

describe("ticket progress chart", () => {
	it("keeps elapsed dates proportional across gaps in observed history", () => {
		expect(progressX(points, points[0].date, 44, 400)).toBe(44)
		expect(progressX(points, points[1].date, 44, 400)).toBe(84)
		expect(progressX(points, points[2].date, 44, 400)).toBe(444)
		expect(nearestProgressPoint(points, 0.2)).toBe(1)
		expect(nearestProgressPoint(points, 0.9)).toBe(2)
	})
	it("preserves endpoints and does not overshoot increasing, decreasing, or unchanged observations", () => {
		for (const [from, to] of [
			[0, 18],
			[30, 15],
			[20, 20],
		]) {
			expect(sampleRenderedCurve(from, to, 0)).toBe(from)
			expect(sampleRenderedCurve(from, to, 1)).toBe(to)
			for (let step = 0; step <= 100; step++) {
				const value = sampleRenderedCurve(from, to, step / 100)
				expect(value).toBeGreaterThanOrEqual(Math.min(from, to) - 1e-10)
				expect(value).toBeLessThanOrEqual(Math.max(from, to) + 1e-10)
			}
		}
	})
	it("keeps completed below total scope between observations, including reopened and removed work", () => {
		for (let step = 0; step <= 100; step++) {
			const complete = sampleRenderedCurve(18, 5, step / 100)
			const scope = sampleRenderedCurve(20, 8, step / 100)
			expect(complete).toBeLessThanOrEqual(scope)
		}
	})
	it("draws one real observation as a point without inventing a history segment", () => {
		expect(smoothProgressPath([])).toBe("")
		expect(smoothProgressPath([{ x: 10, y: 20 }])).toBe("M 10 20")
		expect(progressX(points.slice(0, 1), points[0].date, 40, 200)).toBe(140)
		expect(progressTicks(points.slice(0, 1), 3)).toEqual([0])
	})
	it("limits tick count and preserves the first and latest observations", () => {
		const many = Array.from({ length: 31 }, (_, index) => ({
			...points[0],
			date: `2026-10-${String(index + 1).padStart(2, "0")}`,
		}))
		const ticks = progressTicks(many, 3)
		expect(ticks).toHaveLength(3)
		expect(ticks[0]).toBe(0)
		expect(ticks[ticks.length - 1]).toBe(30)
	})
	it("omits overlapping tick labels when recorded dates cluster after a gap", () => {
		const clustered = [
			points[0],
			{ ...points[0], date: "2026-10-02" },
			{ ...points[0], date: "2026-10-03" },
			{ ...points[0], date: "2026-10-31" },
		]
		expect(progressTicks(clustered, 5)).toEqual([0, 3])
	})
})
