import fs from "node:fs/promises"
import path from "node:path"
import i18next from "i18next"
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import common from "../../../i18n/locales/en/common.json"
import { preserveHookOutput } from "../HookOutput"

const artifacts: string[] = []

beforeAll(() => {
	i18next.addResourceBundle("en", "common", common, true, true)
})

afterEach(async () => {
	vi.restoreAllMocks()
	for (const artifact of artifacts.splice(0)) {
		await fs.unlink(artifact)
		await fs.rmdir(path.dirname(artifact))
	}
})

function savedPath(preview: string): string {
	const artifact = preview.match(/Full hook output saved to: (.+)$/)?.[1]
	if (!artifact) throw new Error("Missing full hook output artifact")
	artifacts.push(artifact)
	return artifact
}

describe("hook output preservation", () => {
	it("keeps complete output within the approximate-token limit and treats zero as unlimited", async () => {
		const exact = "x".repeat(10_000)
		expect(await preserveHookOutput(exact)).toBe(exact)
		expect(await preserveHookOutput(exact + "x", 0)).toBe(exact + "x")
	})

	it("preserves the full output and includes both ends in a bounded preview", async () => {
		const full = `first ${"details ".repeat(3_000)} last`
		const preview = await preserveHookOutput(full)
		expect(await fs.readFile(savedPath(preview), "utf8")).toBe(full)
		expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(10_000)
		expect(preview.startsWith("first ")).toBe(true)
		expect(preview).toContain(" last\n\nFull hook output saved to:")
		expect(preview).toContain("tokens truncated")
	})

	it("supports separate per-handler limits without splitting Unicode code points", async () => {
		const full = "🙂 café ".repeat(3_000)
		const preview = await preserveHookOutput(full, 250)
		expect(await fs.readFile(savedPath(preview), "utf8")).toBe(full)
		expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(1_000)
		expect(preview).not.toContain("\ufffd")
	})

	it("reports preservation failure while retaining bounded feedback", async () => {
		vi.spyOn(fs, "mkdtemp").mockRejectedValue(new Error("Unavailable storage"))
		const preview = await preserveHookOutput("first " + "x".repeat(20_000) + " last")
		expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(10_000)
		expect(preview).toContain("Full hook output could not be saved.")
		expect(preview).toContain("first ")
		expect(preview).toContain(" last")
	})
})
