import { describe, expect, it } from "vitest"
import { canonicalFixtureBytes, fixtureTreeDigest } from "../fixtureDigest.mjs"

describe("fixture digest byte contract", () => {
	it("keeps existing LF seals and makes CRLF text portable without hiding content changes", () => {
		const digest = (text: string) => fixtureTreeDigest([{ path: "src/a.ts", bytes: Buffer.from(text) }])
		expect(digest("a\nb\n")).toBe(digest("a\r\nb\r\n"))
		expect(digest("a\nb\n")).not.toBe(digest("a\nc\n"))
		expect(digest("a\rb")).not.toBe(digest("a\nb"))
	})
	it.each([Buffer.from([0, 13, 10]), Buffer.from([255, 13, 10])])("preserves opaque bytes %j", (bytes) => {
		expect(canonicalFixtureBytes(bytes)).toEqual(bytes)
		expect(fixtureTreeDigest([{ path: "binary", bytes }])).not.toBe(
			fixtureTreeDigest([{ path: "binary", bytes: Buffer.from([bytes[0]!, 10]) }]),
		)
	})
	it("orders normalized relative paths and rejects collisions", () => {
		const a = { path: "src\\a", bytes: Buffer.from("a") }
		const b = { path: "src/b", bytes: Buffer.from("b") }
		expect(fixtureTreeDigest([a, b])).toBe(fixtureTreeDigest([b, { ...a, path: "src/a" }]))
		expect(() => fixtureTreeDigest([a, { ...a, path: "src/a" }])).toThrow("Duplicate")
	})
})
