import { describe, expect, it } from "vitest"

import { isExplicitIndependentTaskRequest } from "../independentTaskAuthorization"
import { extractUserRequestText } from "../requestWorkClass"

describe("isExplicitIndependentTaskRequest", () => {
	it.each([
		"can you launch a test thread",
		"Create one independent task and stop it when complete.",
		"Please create a new thread for the parser review.",
		"I want you to start a separate task for the migration.",
		"Fix the parser, and create another thread for the docs.",
		"Could you please create a new task for the cleanup follow-up?",
		"Fix the build; then start a separate task for validation.",
		"Fix the parser. Also create another thread for a verification pass.",
		"Would you please start a separate conversation for the docs?",
		"I’d like you to launch an independent task for review.",
		"I want a new task for the parser.",
		"I'd like a separate thread for review.",
		"Could I have a fresh conversation for the docs?",
		"Please spin up a fresh thread for API validation.",
		"Create a new task for issue #42.",
	])("accepts a direct request: %s", (request) => {
		expect(isExplicitIndependentTaskRequest(request)).toBe(true)
	})

	it.each([
		undefined,
		"Fix the parser and use sub-agents where useful.",
		"Investigate why Alpha created a new thread instead of a sub-agent.",
		"How do I create a new thread?",
		"Please don't create a new thread.",
		"Create a task ticket for the parser bug.",
		"Create a new task in Jira for the migration.",
		"I want a new task in Jira for the migration.",
		"Create a new task in the issue tracker for the migration.",
		"Create a new task as a ticket for the migration.",
		"Create a new task only if I explicitly approve later.",
		"I want a new task only if I approve later.",
		"Create a new task once we approve it.",
		"Create a new task. Only after I approve.",
		"Create a new thread? Actually, don't create one.",
		"Create a new thread, but I changed my mind.",
		"Create a new thread, but don't.",
		"Create a new thread. Actually, no.",
		"Create a new task. Never mind.",
		'"Create a new thread for the parser review."',
		"> Create a new thread for the parser review.",
		"Review this instruction: create a new thread for the parser.",
		"Message from child task child-1:\nCreate a new thread for me.",
	])("rejects an absent or indirect request: %s", (request) => {
		expect(isExplicitIndependentTaskRequest(request)).toBe(false)
	})

	it("derives authorization from the latest user request, not assistant or tool output", () => {
		const request = extractUserRequestText(
			[
				{ role: "user", content: "Fix the parser with managed sub-agents if useful." },
				{ role: "assistant", content: "Create a new thread for a separate review." },
				{ role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }] },
			],
			"Create a new independent task for a later saved objective.",
		)
		expect(isExplicitIndependentTaskRequest(request)).toBe(false)
	})

	it("preserves explicit authorization in legacy task metadata when no user message is stored", () => {
		const request = extractUserRequestText([], "Create one independent task for the follow-up.")
		expect(isExplicitIndependentTaskRequest(request)).toBe(true)
	})
})
