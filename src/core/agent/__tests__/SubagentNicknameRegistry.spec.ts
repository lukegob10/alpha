import { SUBAGENT_CALLSIGNS, SubagentNicknameRegistry } from "../SubagentNicknameRegistry"

const sequentialRegistry = (callsigns: readonly string[] = SUBAGENT_CALLSIGNS) =>
	new SubagentNicknameRegistry({ callsigns, pickIndex: () => 0 })

describe("SUBAGENT_CALLSIGNS", () => {
	it("is a unique Title-case callsign pool", () => {
		expect(SUBAGENT_CALLSIGNS.length).toBeGreaterThanOrEqual(50)
		expect(SUBAGENT_CALLSIGNS.length).toBeLessThanOrEqual(60)
		expect(new Set(SUBAGENT_CALLSIGNS.map((name) => name.toLowerCase())).size).toBe(SUBAGENT_CALLSIGNS.length)
		expect(SUBAGENT_CALLSIGNS).toEqual([...SUBAGENT_CALLSIGNS].sort())
		for (const name of SUBAGENT_CALLSIGNS) {
			expect(name).toMatch(/^[A-Z][a-z]+$/)
		}
	})
})

describe("SubagentNicknameRegistry", () => {
	it("rejects an empty callsign pool", () => {
		expect(() => new SubagentNicknameRegistry({ callsigns: [] })).toThrow("at least one name")
	})

	it("assigns unused callsigns without collisions", () => {
		const registry = sequentialRegistry(["Forge", "Harbor", "Kestrel", "Vega"])
		const first = registry.assign(2)
		const second = registry.assign(2, first)

		expect(first).toEqual(["Forge", "Harbor"])
		expect(second).toEqual(["Kestrel", "Vega"])
		expect(new Set([...first, ...second]).size).toBe(4)
	})

	it("picks randomly from the unused callsign pool", () => {
		const picks = [2, 0]
		const registry = new SubagentNicknameRegistry({
			callsigns: ["Forge", "Harbor", "Kestrel"],
			pickIndex: (size) => {
				expect(size).toBeGreaterThan(0)
				return picks.shift() ?? 0
			},
		})

		expect(registry.assign(2)).toEqual(["Kestrel", "Forge"])
	})

	it("does not restart at the same names across assignments in one session", () => {
		const registry = sequentialRegistry(["Forge", "Harbor", "Kestrel"])

		expect(registry.assign(1)).toEqual(["Forge"])
		expect(registry.assign(1)).toEqual(["Harbor"])
	})

	it("skips names already persisted in task history", () => {
		const registry = sequentialRegistry(["Forge", "Harbor", "Kestrel"])
		expect(registry.assign(1, ["Forge", "Harbor"])).toEqual(["Kestrel"])
	})

	it("uses requested stable names and fills unnamed positions without collisions", () => {
		const registry = sequentialRegistry(["Forge", "Harbor", "Kestrel"])

		expect(registry.assign(2, ["Forge"], ["backend_review", undefined])).toEqual(["backend_review", "Harbor"])
	})

	it("reserves later requested names before filling an earlier unnamed position", () => {
		const registry = sequentialRegistry(["Forge", "Harbor", "Kestrel"])

		expect(registry.assign(2, [], [undefined, "Forge"])).toEqual(["Harbor", "Forge"])
	})

	it("reuses exhausted callsigns with a numeric suffix", () => {
		const registry = sequentialRegistry(["Forge"])

		expect(registry.assign(2)).toEqual(["Forge", "Forge 2"])
		expect(registry.assign(1, ["Forge", "Forge 2"])).toEqual(["Forge 3"])
	})

	it("rejects a requested name that is already reserved", () => {
		const registry = sequentialRegistry()

		expect(() => registry.assign(1, ["backend_review"], ["backend_review"])).toThrow("already in use")
	})

	it("rejects batches outside the public one-to-two limit", () => {
		const registry = sequentialRegistry()
		expect(() => registry.assign(3)).toThrow("one or two")
	})

	it("rejects a picker that returns an out-of-range index", () => {
		const registry = new SubagentNicknameRegistry({
			callsigns: ["Forge"],
			pickIndex: () => 4,
		})

		expect(() => registry.assign(1)).toThrow("invalid index")
	})
})
