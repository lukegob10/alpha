import { describe, expect, it } from "vitest"
import { readWithSlice } from "../indentation-reader"
import { prepareFileRead, renderFileRead } from "../../../core/tools/readFileContent"

describe("large specification ingestion investigation", () => {
	it("reports long-line content loss as truncation in the file-mention reader", () => {
		const spec = "Requirement 1: ".padEnd(20_000, "a") + " Requirement 100: preserve this final acceptance check."
		const result = readWithSlice(spec)
		expect(result.content).not.toContain("Requirement 100")
		expect(result.totalLines).toBe(1)
		expect(result.wasTruncated).toBe(true)
	})

	it("retains the tail of a single specification line when the canonical read allowance fits", () => {
		const spec = "Requirement 1: ".padEnd(20_000, "a") + " Requirement 100: preserve this final acceptance check."
		const result = renderFileRead(prepareFileRead(spec, "spec.json", { path: "spec.json" }), 32_000)
		expect(result.content).toContain("Requirement 100")
		expect(result.content).not.toContain("[Partial read:")
	})

	it("supplies a column continuation when the canonical read allowance cannot fit the single line", () => {
		const spec = "Requirement 1: ".padEnd(40_000, "a") + " Requirement 100: preserve this final acceptance check."
		const first = renderFileRead(prepareFileRead(spec, "spec.json", { path: "spec.json" }), 32_000)
		expect(first.content).toContain("[partial line]")
		expect(first.content).toContain("[Partial read: next unread position is line 1, column")
		const continuation = JSON.parse(first.content.split("Continuation: ")[1]!) as {
			path: string
			continuation: string
		}
		const second = renderFileRead(prepareFileRead(spec, "spec.json", continuation), 32_000)
		expect(second.content).toContain("Requirement 100")
	})

	it("reports ordinary omitted lines explicitly in the mention reader", () => {
		const result = readWithSlice(Array.from({ length: 2_001 }, (_, index) => `Requirement ${index + 1}`).join("\n"))
		expect(result.wasTruncated).toBe(true)
		expect(result.includedRanges).toEqual([[1, 2_000]])
	})
})
