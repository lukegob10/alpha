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

	it("uses requested stable names and fills unnamed positions without collisions", () => {
		const registry = new SubagentNicknameRegistry()

		expect(registry.assign(2, ["Beacon"], ["backend_review", undefined])).toEqual(["backend_review", "Cinder"])
	})

	it("reserves later requested names before filling an earlier unnamed position", () => {
		const registry = new SubagentNicknameRegistry()

		expect(registry.assign(2, [], [undefined, "Beacon"])).toEqual(["Cinder", "Beacon"])
	})

	it("rejects a requested name that is already reserved", () => {
		const registry = new SubagentNicknameRegistry()

		expect(() => registry.assign(1, ["backend_review"], ["backend_review"])).toThrow("already in use")
	})

	it("rejects batches outside the public one-to-two limit", () => {
		const registry = new SubagentNicknameRegistry()
		expect(() => registry.assign(3)).toThrow("one or two")
	})
})
