import { parseUnifiedDiff } from "../parseUnifiedDiff"

describe("parseUnifiedDiff", () => {
	it("skips no-newline metadata without corrupting line numbers", () => {
		const source = [
			"--- a/example.txt",
			"+++ b/example.txt",
			"@@ -1 +1 @@",
			"-before",
			"\\ No newline at end of file",
			"+after",
			"\\ No newline at end of file",
		].join("\n")

		expect(parseUnifiedDiff(source)).toEqual([
			{ oldLineNum: 1, newLineNum: null, type: "deletion", content: "before" },
			{ oldLineNum: null, newLineNum: 1, type: "addition", content: "after" },
		])
	})
})
