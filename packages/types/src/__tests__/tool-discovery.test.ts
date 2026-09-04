import { toolNames } from "../tool.js"
import { discoverToolsParamsSchema, discoverToolsResultSchema, type DiscoverToolsResult } from "../tool-discovery.js"

const schemaDigest = "a".repeat(64)
const toolName = "mcp--calendar--list_events"
const functionTool = {
	type: "function" as const,
	function: {
		name: toolName,
		parameters: {
			type: "object",
			properties: { calendar: { type: "string" } },
			additionalProperties: false,
		},
		description: "List calendar events",
		strict: true,
		vendor_extension: { source: "mcp" },
	},
}

const validResult: DiscoverToolsResult = {
	version: 1,
	status: "success",
	activation: "next_step",
	tools: [{ name: toolName, schemaDigest, schema: functionTool }],
	message: "Selected tools are available on the next step.",
}

describe("discover tool wire schemas", () => {
	it("trims a query and defaults the result limit", () => {
		expect(discoverToolsParamsSchema.parse({ query: "  calendar events  " })).toEqual({
			query: "calendar events",
			limit: 3,
		})
	})

	it.each([
		{ query: "", label: "empty query" },
		{ query: "   ", label: "whitespace query" },
		{ query: "x".repeat(257), label: "query over the maximum length" },
	])("rejects a $label", ({ query }) => {
		expect(discoverToolsParamsSchema.safeParse({ query }).success).toBe(false)
	})

	it.each([0, 6, 1.5, null])("rejects an invalid limit: %s", (limit) => {
		expect(discoverToolsParamsSchema.safeParse({ query: "calendar", limit }).success).toBe(false)
	})

	it("rejects unknown argument keys at the runtime boundary", () => {
		expect(discoverToolsParamsSchema.safeParse({ query: "calendar", extra: true }).success).toBe(false)
	})

	it("validates a versioned next-step receipt and preserves canonical function keys", () => {
		const parsed = discoverToolsResultSchema.safeParse(validResult)

		expect(parsed.success).toBe(true)
		if (parsed.success) {
			const [tool] = parsed.data.tools
			expect(tool).toBeDefined()
			if (tool) {
				expect(tool.schema.function.strict).toBe(true)
				expect(tool.schema.function.vendor_extension).toEqual({ source: "mcp" })
			}
		}
	})

	it("requires the reference name to match the function name", () => {
		expect(
			discoverToolsResultSchema.safeParse({
				...validResult,
				tools: [{ ...validResult.tools[0], name: "mcp--calendar--different" }],
			}).success,
		).toBe(false)
	})

	it("enforces version, activation, reference digest, and tool count bounds", () => {
		expect(discoverToolsResultSchema.safeParse({ ...validResult, version: 2 }).success).toBe(false)
		expect(discoverToolsResultSchema.safeParse({ ...validResult, activation: "current_step" }).success).toBe(false)
		expect(
			discoverToolsResultSchema.safeParse({
				...validResult,
				tools: [{ ...validResult.tools[0], schemaDigest: "A".repeat(64) }],
			}).success,
		).toBe(false)
		expect(
			discoverToolsResultSchema.safeParse({
				...validResult,
				tools: Array.from({ length: 6 }, (_, index) => ({
					...validResult.tools[0],
					name: `${toolName}-${index}`,
					schema: { ...functionTool, function: { ...functionTool.function, name: `${toolName}-${index}` } },
				})),
			}).success,
		).toBe(false)
	})

	it("bounds the optional result message", () => {
		expect(discoverToolsResultSchema.safeParse({ ...validResult, message: "x".repeat(513) }).success).toBe(false)
	})

	it("adds discover_tools to the shared tool-name contract", () => {
		expect(toolNames).toContain("discover_tools")
	})
})
