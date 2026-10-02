import { describe, expect, it } from "vitest"

import { classifyRequestWorkClass, extractUserRequestText } from "../requestWorkClass"
import { toolNamesReferencedInHistory } from "../lookupToolCatalog"

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

	it("keeps action requests full when phrased as polite questions", () => {
		for (const request of [
			"Can you add retry backoff?",
			"Could you fix the writer?",
			"Would you update the timeout?",
			"Will you remove the obsolete settings?",
			"I want you to change the cache key.",
			"We need to patch the request handler.",
			"What file owns the timeout? Then update it.",
		]) {
			expect(classifyRequestWorkClass(request), request).toMatchObject({ class: "full" })
		}
	})

	it("recognizes implementation and workflow requests", () => {
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
		expect(classifyRequestWorkClass("Use update_plan to track the implementation.")).toMatchObject({
			class: "full",
			reason: "explicit_workflow",
		})
	})

	it("recognizes browser interactions despite unrelated read-only constraints", () => {
		const request =
			"Use Alpha's integrated VS Code browser tools to open that URL, inspect the page, select a category filter, add one synthetic item, and reload it. Do not modify inventory.csv, credentials, or VS Code profile settings."

		expect(classifyRequestWorkClass(request)).toMatchObject({
			class: "full",
			reason: "explicit_workflow",
		})
	})

	it("keeps browser workflows full across wording, order, and prompt length", () => {
		const longPrompt = [
			"In the integrated browser,",
			"Use only the synthetic test account, follow the displayed confirmation, and report the final order state. ".repeat(
				8,
			),
			"click the checkout button; do not edit source files.",
		].join(" ")

		for (const request of [
			"Test the site's checkout flow in the browser; do not edit source files.",
			"Test the site's checkout flow in the browser; don't edit source files.",
			"In the browser, verify the checkout flow and do not modify source files.",
			"Please run through the checkout flow on the website; do not change source files.",
			"Can you test the site's checkout flow in the browser? Do not edit source files.",
			"What browser tools are available? Then open the checkout page and verify the flow; do not edit source files.",
			"What browser tools are available? I want you to test the checkout flow in the browser; do not edit source files.",
			"What does the checkout page show? Do not edit source files.",
			longPrompt,
		]) {
			expect(classifyRequestWorkClass(request), request).toMatchObject({
				class: "full",
				reason: "explicit_workflow",
			})
		}
	})

	it("classifies browser capability and how-to questions as lookup", () => {
		for (const request of [
			"Can you explain what the browser tools do? Do not modify inventory.csv.",
			"What browser tools are available? Do not edit source files.",
			"Can browser tools click and type on a page? Do not edit source files.",
			"How do I use the integrated browser tools? Do not edit source files.",
		]) {
			expect(classifyRequestWorkClass(request), request).toMatchObject({
				class: "lookup",
				reason: "lookup_question",
			})
		}
	})

	it("keeps task orchestration tools for requests phrased as questions about taking action", () => {
		for (const text of [
			"can you launch a test thread",
			"Could you start another chat to inspect the backend?",
			"Can you create a separate task with sub-agents?",
			"Can you send a message to the child thread?",
			"Can you stop that task?",
		]) {
			expect(classifyRequestWorkClass(text), text).toMatchObject({
				class: "full",
				reason: "explicit_workflow",
			})
		}
		expect(classifyRequestWorkClass("How do I launch a thread?")).toMatchObject({ class: "lookup" })
	})

	it("recognizes named skills and tickets in lookup requests", () => {
		const skill = classifyRequestWorkClass("Where is the exporter registered? Use the pdf-processing skill.")
		expect(skill).toMatchObject({ class: "lookup", includeSkill: true, includeTickets: false })

		const ticket = classifyRequestWorkClass("Read ticket AB-123 and tell me where the mentioned helper lives.")
		expect(ticket).toMatchObject({ class: "lookup", includeTickets: true })
	})

	it("recognizes ordinary ticket questions and project references as ticket lookups", () => {
		for (const text of [
			"Which Alpha tickets are in progress?",
			"What is PM-01 about?",
			"What is PM number one about?",
			"Where is PM number 1 documented?",
		]) {
			const decision = classifyRequestWorkClass(text)
			expect(decision, text).toMatchObject({ class: "lookup", includeTickets: true })
		}
	})

	it("does not classify ambiguous or empty text as lookup", () => {
		expect(classifyRequestWorkClass(undefined)).toMatchObject({ class: "full", reason: "empty" })
		expect(classifyRequestWorkClass("")).toMatchObject({ class: "full", reason: "empty" })
		expect(classifyRequestWorkClass("Handle the scheduler.")).toMatchObject({ class: "full", reason: "uncertain" })
		expect(classifyRequestWorkClass("How do I implement retries?")).toMatchObject({ class: "full" })
		expect(classifyRequestWorkClass("ok")).toMatchObject({ class: "full", reason: "uncertain" })
	})

	it("classifies managed-child work as full", () => {
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

describe("toolNamesReferencedInHistory", () => {
	it("collects assistant tool_use names and ignores user text", () => {
		expect(
			toolNamesReferencedInHistory([
				{ role: "user", content: "Where is retryLimit defined?" },
				{
					role: "assistant",
					content: [
						{ type: "text", text: "looking" },
						{ type: "tool_use", id: "1", name: "spawn_agent", input: {} },
						{ type: "tool_use", id: "2", name: "search_files", input: {} },
					],
				},
			]),
		).toEqual(["search_files", "spawn_agent"])
	})
})
