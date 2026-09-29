import { describe, expect, it } from "vitest"

import { getNativeTools } from ".."

describe("diagnostic native tool catalog", () => {
	it("keeps the evidence reader out of ordinary task catalogs", () => {
		const names = getNativeTools().flatMap((tool) => (tool.type === "function" ? [tool.function.name] : []))

		expect(names).not.toContain("read_diagnostic_evidence")
	})

	it("returns only a zero-argument evidence reader for diagnostic sessions", () => {
		const tools = getNativeTools({ diagnosticSession: true })

		expect(tools).toHaveLength(1)
		expect(tools[0]).toMatchObject({
			type: "function",
			function: {
				name: "read_diagnostic_evidence",
				parameters: { type: "object", properties: {}, additionalProperties: false },
			},
		})
	})
})
