import { describe, expect, it } from "vitest"
import { openDiffPayloadSchema } from "../vscode-extension-host.js"

describe("diff review requests", () => {
	it("accepts captured deletions and legacy patches", () => {
		expect(
			openDiffPayloadSchema.parse({ files: [{ path: "deleted.ts", originalContent: "old", finalContent: "" }] }),
		).toEqual({ files: [{ path: "deleted.ts", originalContent: "old", finalContent: "" }] })
		expect(openDiffPayloadSchema.parse({ patch: { path: "legacy.ts", content: "-old\n+new" } })).toEqual({
			patch: { path: "legacy.ts", content: "-old\n+new" },
		})
	})

	it.each([
		{ files: [] },
		{ files: Array.from({ length: 129 }, () => ({ path: "file.ts", originalContent: "", finalContent: "" })) },
		{ patch: { path: "", content: "patch" } },
		{ patch: { path: "x".repeat(4097), content: "patch" } },
		{ patch: { path: "file.ts", content: 5 } },
		{ title: "x".repeat(257), patch: { path: "file.ts", content: "patch" } },
	])("rejects malformed or unbounded requests", (payload) => {
		expect(openDiffPayloadSchema.safeParse(payload).success).toBe(false)
	})
})
