import { getPatchPaths, mapPatchPaths, parsePatch, ParseError } from "../parser"
import { applyChunksToContent } from "../apply"

describe("apply_patch parser", () => {
	describe("operation paths", () => {
		const patch =
			"*** Begin Patch\n*** Add File: added.txt\n+new\n  *** Delete File: deleted.txt\n  *** Update File: source.txt\n*** Move to: destination.txt\n@@\n *** Add File: literal.txt\n-old\n+new\n*** End Patch"

		it("extracts padded operation sources and move targets without treating context as an operation", () => {
			expect(getPatchPaths(patch)).toEqual(["added.txt", "deleted.txt", "source.txt", "destination.txt"])
		})

		it("maps the same parsed targets while preserving marker-like context", () => {
			const mapPath = vi.fn((filePath: string) => `nested/${filePath}`)
			const mapped = mapPatchPaths(patch, mapPath)

			expect(getPatchPaths(mapped)).toEqual([
				"nested/added.txt",
				"nested/deleted.txt",
				"nested/source.txt",
				"nested/destination.txt",
			])
			expect(mapPath.mock.calls.flat()).toEqual(getPatchPaths(patch))
			expect(mapped).toContain("\n *** Add File: literal.txt\n")
		})

		it("rejects malformed patches at both policy and mapping boundaries", () => {
			const malformed = "*** Begin Patch\n*** Update File: empty.txt\n*** End Patch"
			expect(() => getPatchPaths(malformed)).toThrow(ParseError)
			expect(() => mapPatchPaths(malformed, (filePath) => filePath)).toThrow(ParseError)
		})

		it.each(["", "first\nsecond", "first\rsecond"])("rejects an unrepresentable mapped path %j", (mapped) => {
			expect(() => mapPatchPaths(patch, () => mapped)).toThrow(ParseError)
		})
	})

	describe("parsePatch", () => {
		it.each(["LF", "CRLF", "mixed"])("keeps %s patch separators out of CRLF file content", (separators) => {
			const replacement = "value = $& $$ $1 $` $' &lt; &amp; &#36;"
			const original = "\uFEFFheader\r\nvalue = old\r\nfooter"
			const lines = [
				"*** Begin Patch",
				"*** Update File: bytes.txt",
				"@@",
				"-header",
				"-value = old",
				"-footer",
				"+header",
				`+${replacement}`,
				"+footer",
				"*** End Patch",
			]
			const patch = lines
				.map((line, index) => {
					if (index === lines.length - 1) return line
					const crlf = separators === "CRLF" || (separators === "mixed" && line.startsWith("+"))
					return line + (crlf ? "\r\n" : "\n")
				})
				.join("")
			const hunk = parsePatch(patch).hunks[0]!
			expect(hunk.type).toBe("UpdateFile")
			if (hunk.type !== "UpdateFile") throw new Error("Expected update hunk")
			expect(hunk.path).toBe("bytes.txt")
			const content = applyChunksToContent(original, hunk.path, hunk.chunks)
			expect(Buffer.from(content)).toEqual(Buffer.from(original.replace("value = old", () => replacement)))
		})

		it("should reject patch without Begin Patch marker", () => {
			expect(() => parsePatch("bad")).toThrow(ParseError)
			expect(() => parsePatch("bad")).toThrow("The first line of the patch must be '*** Begin Patch'")
		})

		it("should reject patch without End Patch marker", () => {
			expect(() => parsePatch("*** Begin Patch\nbad")).toThrow(ParseError)
			expect(() => parsePatch("*** Begin Patch\nbad")).toThrow(
				"The last line of the patch must be '*** End Patch'",
			)
		})

		it("should parse empty patch", () => {
			const result = parsePatch("*** Begin Patch\n*** End Patch")
			expect(result.hunks).toEqual([])
		})

		it("should parse Add File hunk", () => {
			const result = parsePatch(`*** Begin Patch
*** Add File: path/add.py
+abc
+def
*** End Patch`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "AddFile",
				path: "path/add.py",
				contents: "abc\ndef\n",
			})
		})

		it("should parse Delete File hunk", () => {
			const result = parsePatch(`*** Begin Patch
*** Delete File: path/delete.py
*** End Patch`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "DeleteFile",
				path: "path/delete.py",
			})
		})

		it("should parse Update File hunk with context", () => {
			const result = parsePatch(`*** Begin Patch
*** Update File: path/update.py
@@ def f():
-    pass
+    return 123
*** End Patch`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "UpdateFile",
				path: "path/update.py",
				movePath: null,
				chunks: [
					{
						changeContext: "def f():",
						oldLines: ["    pass"],
						newLines: ["    return 123"],
						contextLineIndices: [],
						isEndOfFile: false,
					},
				],
			})
		})

		it("should parse Update File hunk with Move to", () => {
			const result = parsePatch(`*** Begin Patch
*** Update File: path/update.py
*** Move to: path/update2.py
@@ def f():
-    pass
+    return 123
*** End Patch`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "UpdateFile",
				path: "path/update.py",
				movePath: "path/update2.py",
				chunks: [
					{
						changeContext: "def f():",
						oldLines: ["    pass"],
						newLines: ["    return 123"],
						contextLineIndices: [],
						isEndOfFile: false,
					},
				],
			})
		})

		it("should parse Update File hunk with empty context marker", () => {
			const result = parsePatch(`*** Begin Patch
*** Update File: file.py
@@
+line
*** End Patch`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "UpdateFile",
				path: "file.py",
				movePath: null,
				chunks: [
					{
						changeContext: null,
						oldLines: [],
						newLines: ["line"],
						contextLineIndices: [],
						isEndOfFile: false,
					},
				],
			})
		})

		it("should parse multiple hunks", () => {
			const result = parsePatch(`*** Begin Patch
*** Add File: path/add.py
+abc
+def
*** Delete File: path/delete.py
*** Update File: path/update.py
*** Move to: path/update2.py
@@ def f():
-    pass
+    return 123
*** End Patch`)

			expect(result.hunks).toHaveLength(3)
			expect(result.hunks[0]).toEqual({
				type: "AddFile",
				path: "path/add.py",
				contents: "abc\ndef\n",
			})
			expect(result.hunks[1]).toEqual({
				type: "DeleteFile",
				path: "path/delete.py",
			})
			expect(result.hunks[2]).toEqual({
				type: "UpdateFile",
				path: "path/update.py",
				movePath: "path/update2.py",
				chunks: [
					{
						changeContext: "def f():",
						oldLines: ["    pass"],
						newLines: ["    return 123"],
						contextLineIndices: [],
						isEndOfFile: false,
					},
				],
			})
		})

		it("should parse Update hunk followed by Add hunk", () => {
			const result = parsePatch(`*** Begin Patch
*** Update File: file.py
@@
+line
*** Add File: other.py
+content
*** End Patch`)

			expect(result.hunks).toHaveLength(2)
			expect(result.hunks[0]).toEqual({
				type: "UpdateFile",
				path: "file.py",
				movePath: null,
				chunks: [
					{
						changeContext: null,
						oldLines: [],
						newLines: ["line"],
						contextLineIndices: [],
						isEndOfFile: false,
					},
				],
			})
			expect(result.hunks[1]).toEqual({
				type: "AddFile",
				path: "other.py",
				contents: "content\n",
			})
		})

		it("should parse Update hunk without explicit @@ header for first chunk", () => {
			const result = parsePatch(`*** Begin Patch
*** Update File: file2.py
 import foo
+bar
*** End Patch`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "UpdateFile",
				path: "file2.py",
				movePath: null,
				chunks: [
					{
						changeContext: null,
						oldLines: ["import foo"],
						newLines: ["import foo", "bar"],
						contextLineIndices: [[0, 0]],
						isEndOfFile: false,
					},
				],
			})
		})

		it("should reject empty Update File hunk", () => {
			expect(() =>
				parsePatch(`*** Begin Patch
*** Update File: test.py
*** End Patch`),
			).toThrow(ParseError)
		})

		it("should handle heredoc-wrapped patches (lenient mode)", () => {
			const result = parsePatch(`<<EOF
*** Begin Patch
*** Add File: foo
+hi
*** End Patch
EOF`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "AddFile",
				path: "foo",
				contents: "hi\n",
			})
		})

		it("should handle single-quoted heredoc", () => {
			const result = parsePatch(`<<'EOF'
*** Begin Patch
*** Add File: foo
+hi
*** End Patch
EOF`)

			expect(result.hunks).toHaveLength(1)
		})

		it("should handle double-quoted heredoc", () => {
			const result = parsePatch(`<<"EOF"
*** Begin Patch
*** Add File: foo
+hi
*** End Patch
EOF`)

			expect(result.hunks).toHaveLength(1)
		})

		it("should parse chunk with End of File marker", () => {
			const result = parsePatch(`*** Begin Patch
*** Update File: file.py
@@
+line
*** End of File
*** End Patch`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "UpdateFile",
				path: "file.py",
				movePath: null,
				chunks: [
					{
						changeContext: null,
						oldLines: [],
						newLines: ["line"],
						contextLineIndices: [],
						isEndOfFile: true,
					},
				],
			})
		})

		it("should parse multiple chunks in one Update File", () => {
			const result = parsePatch(`*** Begin Patch
*** Update File: multi.txt
@@
 foo
-bar
+BAR
@@
 baz
-qux
+QUX
*** End Patch`)

			expect(result.hunks).toHaveLength(1)
			expect(result.hunks[0]).toEqual({
				type: "UpdateFile",
				path: "multi.txt",
				movePath: null,
				chunks: [
					{
						changeContext: null,
						oldLines: ["foo", "bar"],
						newLines: ["foo", "BAR"],
						contextLineIndices: [[0, 0]],
						isEndOfFile: false,
					},
					{
						changeContext: null,
						oldLines: ["baz", "qux"],
						newLines: ["baz", "QUX"],
						contextLineIndices: [[0, 0]],
						isEndOfFile: false,
					},
				],
			})
		})
	})
})
