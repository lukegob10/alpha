import { describe, expect, it } from "vitest"

import { classifyRequestWorkClass, extractUserRequestText } from "../requestWorkClass"
import { resolveLookupToolNames } from "../lookupToolCatalog"

describe("classifyRequestWorkClass", () => {
	it("classifies interrogative location and existence questions as lookup", () => {
		const questions = [
			"Where is retryLimit defined?",
			"Where are application logs written?",
			"What file declares the default timeout?",
			"Does this repo contain harbor.yaml?",
			"Which file exports createScheduler?",
			"What is the default retry limit in src/config.js? Cite the declaration. Do not change files.",
		]
		for (const text of questions) {
			expect(classifyRequestWorkClass(text), text).toMatchObject({
				class: "lookup",
				reason: "lookup_question",
				includeSkill: false,
				includeTickets: false,
			})
		}
	})

	it("does not treat the word logs as a special case", () => {
		expect(classifyRequestWorkClass("Where is the output path configured?")).toMatchObject({ class: "lookup" })
		expect(classifyRequestWorkClass("Add log rotation to the writer.")).toMatchObject({ class: "full" })
	})

	it("keeps the full catalog when implementation or workflow is requested", () => {
		expect(classifyRequestWorkClass("Implement retry backoff in the scheduler.")).toMatchObject({
			class: "full",
			reason: "implementation",
		})
		expect(classifyRequestWorkClass("Fix the stale write check and add a test.")).toMatchObject({
			class: "full",
			reason: "implementation",
		})
		expect(classifyRequestWorkClass("Find the retry helper and then fix the off-by-one.")).toMatchObject({
			class: "full",
			reason: "implementation",
		})
		expect(classifyRequestWorkClass("File a ticket for the completion hang.")).toMatchObject({
			class: "full",
			reason: "explicit_workflow",
		})
		expect(classifyRequestWorkClass("Spawn an explore agent to map the auth package.")).toMatchObject({
			class: "full",
			reason: "explicit_workflow",
		})
	})

	it("keeps skill and ticket extras without hiding a named skill or ticket on lookup", () => {
		const skill = classifyRequestWorkClass("Where is the exporter registered? Use the pdf-processing skill.")
		expect(skill).toMatchObject({ class: "lookup", includeSkill: true, includeTickets: false })
		expect([...resolveLookupToolNames(skill)!]).toEqual(expect.arrayContaining(["skill", "search_files"]))

		const ticket = classifyRequestWorkClass("Read ticket AB-123 and tell me where the mentioned helper lives.")
		expect(ticket).toMatchObject({ class: "lookup", includeTickets: true })
		expect([...resolveLookupToolNames(ticket)!]).toEqual(expect.arrayContaining(["read_ticket", "list_tickets"]))
	})

	it("does not classify ambiguous or empty text as lookup", () => {
		expect(classifyRequestWorkClass(undefined)).toMatchObject({ class: "full", reason: "empty" })
		expect(classifyRequestWorkClass("")).toMatchObject({ class: "full", reason: "empty" })
		expect(classifyRequestWorkClass("Handle the scheduler.")).toMatchObject({ class: "full", reason: "uncertain" })
		expect(classifyRequestWorkClass("How do I implement retries?")).toMatchObject({ class: "full" })
		expect(classifyRequestWorkClass("ok")).toMatchObject({ class: "full", reason: "uncertain" })
	})

	it("does not narrow managed-child catalogs", () => {
		expect(classifyRequestWorkClass("Where is retryLimit defined?", { taskKind: "subagent" })).toMatchObject({
			class: "full",
			reason: "subagent",
		})
	})
})

describe("extractUserRequestText", () => {
	it("prefers the latest user_message wrapper and skips tool-result rows", () => {
		const text = extractUserRequestText(
			[
				{ role: "user", content: "<user_message>\nWhere is retryLimit defined?\n</user_message>" },
				{ role: "assistant", content: "searching" },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
			],
			"fallback",
		)
		expect(text).toBe("Where is retryLimit defined?")
	})

	it("strips environment details and falls back to the original task text", () => {
		expect(
			extractUserRequestText(
				[
					{
						role: "user",
						content: "hello\n<environment_details>\ncwd: /tmp\n</environment_details>",
					},
				],
				"Where is X?",
			),
		).toBe("hello")
		expect(extractUserRequestText([], "Where is X?")).toBe("Where is X?")
		expect(extractUserRequestText([])).toBeUndefined()
	})
})
