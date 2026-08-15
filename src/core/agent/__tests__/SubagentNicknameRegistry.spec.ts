import { SubagentNicknameRegistry } from "../SubagentNicknameRegistry"

describe("SubagentNicknameRegistry", () => {
	it("assigns stable Alpha-specific names without collisions", () => {
		const registry = new SubagentNicknameRegistry()
		const first = registry.assign(2)
		const second = registry.assign(2, first)

		expect(new Set([...first, ...second]).size).toBe(4)
		expect(first).toEqual(["Beacon", "Cinder"])
	})

	it("skips names already persisted in task history", () => {
		const registry = new SubagentNicknameRegistry()
		expect(registry.assign(1, ["Beacon", "Cinder"])).toEqual(["Drift"])
	})

	it("rejects batches outside the public one-to-two limit", () => {
		const registry = new SubagentNicknameRegistry()
		expect(() => registry.assign(3)).toThrow("one or two")
	})
})
