import { applyChunksToContent, ApplyPatchError } from "../apply"
import { parsePatch, type UpdateFileChunk } from "../parser"

describe("apply-patch apply", () => {
	describe("applyChunksToContent", () => {
		it.each(["\n", "\r\n"])("preserves fuzzy-matched context bytes with %j endings", (eol) => {
			const original = `\uFEFF    const label = "a—b"\t${eol}value=old${eol}footer${eol}`
			const [hunk] = parsePatch(
				'*** Begin Patch\n*** Update File: test.txt\n@@\n const label = "a-b"\n-value=old\n+value=new\n footer\n*** End Patch',
			).hunks
			if (hunk?.type !== "UpdateFile") throw new Error("Expected update hunk")

			expect(applyChunksToContent(original, hunk.path, hunk.chunks)).toBe(
				original.replace("value=old", "value=new"),
			)
		})

		it("preserves the context occurrence when identical patch lines remove an earlier occurrence", () => {
			const [hunk] = parsePatch(
				"*** Begin Patch\n*** Update File: test.txt\n@@\n-same\n same\n*** End Patch",
			).hunks
			if (hunk?.type !== "UpdateFile") throw new Error("Expected update hunk")

			expect(applyChunksToContent("  same\n    same\n", hunk.path, hunk.chunks)).toBe("    same\n")
		})

		it("preserves contexts between unequal edited segments and a trailing newline sentinel", () => {
			const [hunk] = parsePatch(
				"*** Begin Patch\n*** Update File: test.txt\n@@\n one\n-old\n+new\n+extra\n two\n-remove\n three\n \n*** End of File\n*** End Patch",
			).hunks
			if (hunk?.type !== "UpdateFile") throw new Error("Expected update hunk")

			expect(applyChunksToContent("  one\nold\n  two\nremove\n  three\n", hunk.path, hunk.chunks)).toBe(
				"  one\nnew\nextra\n  two\n  three\n",
			)
		})

		it("should apply simple replacement", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo", "bar"],
					newLines: ["foo", "baz"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbaz\n")
		})

		it("should apply insertion", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo"],
					newLines: ["foo", "inserted"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\ninserted\nbar\n")
		})

		it("should apply deletion", () => {
			const original = "foo\nbar\nbaz\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo", "bar"],
					newLines: ["foo"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbaz\n")
		})

		it("should apply multiple chunks", () => {
			const original = "foo\nbar\nbaz\nqux\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo", "bar"],
					newLines: ["foo", "BAR"],
					isEndOfFile: false,
				},
				{
					changeContext: null,
					oldLines: ["baz", "qux"],
					newLines: ["baz", "QUX"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nBAR\nbaz\nQUX\n")
		})

		it("should use context to find location", () => {
			const original = "class Foo:\n    def bar(self):\n        pass\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: "def bar(self):",
					oldLines: ["        pass"],
					newLines: ["        return 123"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.py", chunks)
			expect(result).toBe("class Foo:\n    def bar(self):\n        return 123\n")
		})

		it("should throw when context not found", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: "nonexistent",
					oldLines: ["foo"],
					newLines: ["baz"],
					isEndOfFile: false,
				},
			]
			expect(() => applyChunksToContent(original, "test.txt", chunks)).toThrow(ApplyPatchError)
			expect(() => applyChunksToContent(original, "test.txt", chunks)).toThrow("Failed to find context")
		})

		it("should throw when old lines not found", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["nonexistent"],
					newLines: ["baz"],
					isEndOfFile: false,
				},
			]
			expect(() => applyChunksToContent(original, "test.txt", chunks)).toThrow(ApplyPatchError)
			expect(() => applyChunksToContent(original, "test.txt", chunks)).toThrow("Failed to find expected lines")
		})

		it("should handle pure addition (empty oldLines)", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: [],
					newLines: ["added"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			// Pure addition goes at the end
			expect(result).toBe("foo\nbar\nadded\n")
		})

		it("appends a pure addition even after locating explicit context, matching Codex", () => {
			const original = "before\nanchor\nafter\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: "anchor",
					oldLines: [],
					newLines: ["inserted"],
					isEndOfFile: false,
				},
			]

			expect(applyChunksToContent(original, "test.txt", chunks)).toBe("before\nanchor\nafter\ninserted\n")
		})

		it("should handle isEndOfFile flag", () => {
			const original = "foo\nbar\nbaz\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["baz"],
					newLines: ["BAZ", "qux"],
					isEndOfFile: true,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbar\nBAZ\nqux\n")
		})

		it.each([false, true])("rejects EOF chunks that reuse consumed source lines (sentinel: %s)", (sentinel) => {
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["tail"],
					newLines: ["first"],
					isEndOfFile: false,
				},
				{
					changeContext: null,
					oldLines: sentinel ? ["tail", ""] : ["tail"],
					newLines: sentinel ? ["second", ""] : ["second"],
					isEndOfFile: true,
				},
			]

			expect(() => applyChunksToContent("head\ntail\n", "test.txt", chunks)).toThrow(
				"Failed to find expected lines",
			)
		})

		it("should handle interleaved changes", () => {
			const original = "a\nb\nc\nd\ne\nf\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["a", "b"],
					newLines: ["a", "B"],
					isEndOfFile: false,
				},
				{
					changeContext: null,
					oldLines: ["d", "e"],
					newLines: ["d", "E"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("a\nB\nc\nd\nE\nf\n")
		})

		it("preserves the absence of a trailing newline", () => {
			const original = "foo\nbar"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["bar"],
					newLines: ["baz"],
					isEndOfFile: false,
				},
			]
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbaz")
		})

		it.each(["\n", "\r\n"])("preserves BOM, %j endings and literal replacement text", (eol) => {
			const replacement = "$& $$ $' &amp;"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo"],
					newLines: [replacement],
					isEndOfFile: false,
				},
			]
			expect(applyChunksToContent(`\uFEFFfoo${eol}bar${eol}`, "test.txt", chunks)).toBe(
				`\uFEFF${replacement}${eol}bar${eol}`,
			)
		})

		it("allows an explicit added empty line to terminate an unterminated file", () => {
			expect(
				applyChunksToContent("foo", "test.txt", [
					{
						changeContext: null,
						oldLines: ["foo"],
						newLines: ["foo", ""],
						isEndOfFile: true,
					},
				]),
			).toBe("foo\n")
		})

		it.each([
			["foo\n\n", ["bar"], "bar\n\n"],
			["foo\n", ["bar", ""], "bar\n\n"],
			["foo\n", [], ""],
			["foo", [], ""],
		] as Array<[string, string[], string]>)(
			"preserves explicit blank lines and empty results for %j",
			(original, newLines, expected) => {
				expect(
					applyChunksToContent(original, "test.txt", [
						{
							changeContext: null,
							oldLines: ["foo"],
							newLines,
							isEndOfFile: false,
						},
					]),
				).toBe(expected)
			},
		)

		it("preserves untouched mixed line endings", () => {
			expect(
				applyChunksToContent("foo\r\nbar\nbaz", "test.txt", [
					{
						changeContext: null,
						oldLines: ["foo"],
						newLines: ["changed"],
						isEndOfFile: false,
					},
				]),
			).toBe("changed\r\nbar\nbaz")
		})

		it("preserves CR-only line endings and uses the first ending for inserted lines", () => {
			expect(
				applyChunksToContent("one\rtwo\rthree\r", "test.txt", [
					{
						changeContext: null,
						oldLines: ["two"],
						newLines: ["TWO", "extra"],
						isEndOfFile: false,
					},
				]),
			).toBe("one\rTWO\rextra\rthree\r")
		})

		it("should handle trailing empty line in pattern", () => {
			const original = "foo\nbar\n"
			const chunks: UpdateFileChunk[] = [
				{
					changeContext: null,
					oldLines: ["foo", "bar", ""],
					newLines: ["foo", "baz", ""],
					isEndOfFile: false,
				},
			]
			// Should still work by stripping trailing empty
			const result = applyChunksToContent(original, "test.txt", chunks)
			expect(result).toBe("foo\nbaz\n")
		})
	})
})
