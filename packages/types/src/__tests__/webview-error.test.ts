import { webviewErrorMessageSchema, type WebviewMessage } from "../vscode-extension-host.js"

const diagnostic = {
	type: "webviewError",
	source: "render",
	errorType: "RangeError",
	failure: "invalid_string_length",
	visibility: "visible",
	line: 23,
	column: 17,
} satisfies WebviewMessage

describe("local renderer diagnostic contract", () => {
	it("accepts fixed error categories and numeric locations", () => {
		expect(webviewErrorMessageSchema.parse(diagnostic)).toEqual(diagnostic)
		expect(
			webviewErrorMessageSchema.safeParse({
				...diagnostic,
				source: "resource",
				failure: "resource_load",
				resourceType: "script",
			}).success,
		).toBe(true)
	})

	it.each(["message", "stack", "url", "taskId", "text"])("rejects extra %s content", (field) => {
		expect(webviewErrorMessageSchema.safeParse({ ...diagnostic, [field]: "private-canary" }).success).toBe(false)
	})

	it.each(["source", "errorType", "failure", "visibility", "resourceType"])(
		"rejects unknown %s categories",
		(field) => {
			expect(webviewErrorMessageSchema.safeParse({ ...diagnostic, [field]: "private-canary" }).success).toBe(
				false,
			)
		},
	)

	it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_000_001, "42"])(
		"rejects an invalid location %s",
		(value) => {
			expect(webviewErrorMessageSchema.safeParse({ ...diagnostic, line: value }).success).toBe(false)
			expect(webviewErrorMessageSchema.safeParse({ ...diagnostic, column: value }).success).toBe(false)
		},
	)
})
