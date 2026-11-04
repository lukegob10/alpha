import * as fs from "fs/promises"
import os from "os"
import path from "path"

import { parametersSchema as z } from "@alpha-code/types"

import { CustomToolRegistry } from "../custom-tool-registry.js"

describe("custom tool input schema validation", () => {
	it("rejects nonrepresentable input before publishing a registered tool", () => {
		const registry = new CustomToolRegistry()
		expect(() =>
			registry.register({
				name: "date_input",
				description: "A Date cannot be supplied as JSON",
				parameters: z.object({ value: z.date() }),
				execute: async () => "unused",
			}),
		).toThrow(/date_input.*JSON.*input|date_input.*input.*JSON/)
		expect(registry.has("date_input")).toBe(false)
	})

	it("reports an invalid loaded schema while retaining a valid sibling", async () => {
		const directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-custom-input-schema-"))
		const registry = new CustomToolRegistry()
		try {
			await fs.writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module" }))
			await fs.writeFile(
				path.join(directory, "invalid.js"),
				'export default { name: "invalid_input", description: "Malformed schema", parameters: { _def: {} }, execute: async () => "unused" }',
			)
			await fs.writeFile(
				path.join(directory, "valid.js"),
				'export default { name: "valid_sibling", description: "Valid sibling", execute: async () => "available" }',
			)

			const result = await registry.loadFromDirectory(directory)
			expect(result.loaded).toEqual(["valid_sibling"])
			expect(result.failed).toEqual([
				{ file: "invalid.js", error: expect.stringMatching(/input.*JSON|JSON.*input/) },
			])
			const failure = result.failed[0]
			if (!failure) throw new Error("Expected the rejected custom schema to include a source diagnostic")
			expect(failure.error.length).toBeLessThan(300)
			expect(result.catalog.map((tool) => tool.name)).toEqual(["valid_sibling"])
			expect(registry.has("invalid_input")).toBe(false)
			expect(registry.getAllSerialized().map((tool) => tool.name)).toEqual(["valid_sibling"])
		} finally {
			await fs.rm(directory, { recursive: true, force: true })
		}
	})
})
