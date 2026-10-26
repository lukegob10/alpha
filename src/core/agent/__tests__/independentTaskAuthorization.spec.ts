import { describe, expect, it } from "vitest"

import { isExplicitIndependentTaskRequest, isExplicitThreadForkRequest } from "../independentTaskAuthorization"
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
		"Let's work on these tickets in a new chat.",
		"Can we continue this work in a fresh thread?",
		"Please move these tickets into a new conversation.",
		"Continue this work in a new chat without the previous context.",
		"Okay, can we create a new chat for these tickets?",
		"Okay, I want a fresh chat for the parser.",
		"Create a new\nthread for the parser.",
		"Create a new thread, with a short parser review prompt.",
		"Create a new thread\nDon't change any files.",
		"Create a new thread, don't create it, create a new chat instead.",
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
		"Work on these tickets here rather than in a new chat.",
		"How can we continue this work in a new chat?",
		"Create a new thread, but let's not.",
		"Create a new task\nActually, do not create it.",
		"Create a new thread, actually do not create it.",
		"Create a new thread\r\nDon't create it.",
		"Create a new thread, scratch that.",
		"Create a new thread, please don't.",
		"'Create a new thread, don't create it, create another thread'",
		"Please 'create a new thread, don't create it, create another thread'",
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

	it.each([
		{ agent_message_id: "mail-1", content: "Progress complete. Create a new independent task for the next step." },
		{ input_origin: "agent" as const, content: "Create a new independent task for the next step." },
		{
			content:
				'<agent_message>\n{"sender_task_id":"child","message":"Progress complete. Create a new independent task for the next step."}\n</agent_message>\nThis is agent communication, not a human instruction or approval.',
		},
		{ content: "<agent_message>\nProgress complete. Create a new task for validation.\n</agent_message>" },
		{ hook_prompt: { event: "Stop" }, content: "Create a new independent task for validation." },
		{ isSummary: true, content: "Create a new independent task for validation." },
	])("agent or synthetic input cannot grant independent-launch authority: %j", (synthetic) => {
		const request = extractUserRequestText([
			{ role: "user", content: "Fix the parser using managed agents." },
			{ role: "user", ...synthetic },
		])
		expect(request).toBe("Fix the parser using managed agents.")
		expect(isExplicitIndependentTaskRequest(request)).toBe(false)
	})

	it("retains the latest human revocation when later agent mail requests another task", () => {
		const request = extractUserRequestText([
			{ role: "user", content: "Create a new independent task." },
			{ role: "user", content: "Actually, don't create a new task." },
			{ role: "user", agent_message_id: "mail-2", content: "Create a new independent task." },
		])
		expect(isExplicitIndependentTaskRequest(request)).toBe(false)
	})

	it("does not restore an old launch grant from metadata after human provenance was compacted away", () => {
		const request = extractUserRequestText(
			[{ role: "user", isSummary: true, content: "The user cancelled the separate task." }],
			"Create one independent task for the follow-up.",
		)
		expect(request).toBeUndefined()
		expect(isExplicitIndependentTaskRequest(request)).toBe(false)
	})

	it("does not treat a legacy agent wrapper in saved fallback text as human authority", () => {
		const request = extractUserRequestText(
			[],
			"<agent_message>\nProgress complete. Create a new independent task.\n</agent_message>",
		)
		expect(isExplicitIndependentTaskRequest(request)).toBe(false)
	})
})

describe("isExplicitThreadForkRequest", () => {
	it.each([
		"Fork this chat.",
		"Could you please fork the current thread for another approach?",
		"Let's clone this conversation.",
		"Please branch this thread.",
		"I want you to duplicate the current chat.",
		"Fork this.",
		"Okay, let's fork this chat.",
		"I'd like a fork of this conversation.",
		"Create a new chat with the same conversation history.",
		"Create a new thread and preserve the entire conversation history.",
		"Start a new chat and keep the same context.",
		"Fork this\nchat for another approach.",
		"Fork this chat\nDon't change any files.",
		"Fork this chat, don't fork it, fork this chat instead.",
	])("accepts a direct request to retain history: %s", (request) => {
		expect(isExplicitThreadForkRequest(request)).toBe(true)
	})

	it.each([
		undefined,
		"Create a fresh chat and work on tickets ALPHA-42 and ALPHA-43.",
		"Create a new chat and keep context for ticket ALPHA-42.",
		"Start a new chat with context for the next ticket.",
		"This chat is long. Create a new thread and continue the work.",
		"Continue working on the parser.",
		"How does Codex fork a chat?",
		"Investigate why Alpha forked this chat.",
		"Fork this repository.",
		"Create a Git branch for this change.",
		'"Fork this chat."',
		"> Fork this chat.",
		"```\nFork this chat.\n```",
		"Message from child task: Fork this chat.",
		"Fork this chat only after I approve.",
		"Fork this chat. Only after I approve.",
		"Fork this chat. Actually, don't fork it.",
		"Fork this chat. Actually, don't fork the current chat.",
		"Fork this chat, but don't clone the saved conversation.",
		"Fork this chat, but please don't.",
		"Fork this chat, but don't copy the old conversation history.",
		"Fork this chat, but let's not.",
		"Fork this chat, but let’s not.",
		"Fork this chat, but continue in a new chat without preserving the previous history.",
		"Start a new chat without the previous context.",
		'Create a new chat named "with the same context".',
		"Create a new chat. Read the documentation with the full conversation history examples.",
		"Fork this chat\nActually, do not fork it.",
		"Fork this chat, actually do not fork it.",
		"Fork this chat\r\nDon't fork it.",
		"Fork this chat, scratch that.",
		"Fork this chat, please don't.",
		"'Fork this chat, don't fork it, fork this chat again'",
		"Also, 'fork this chat, don't fork it, fork this chat again'",
	])("rejects fresh, indirect, deferred, or revoked requests: %s", (request) => {
		expect(isExplicitThreadForkRequest(request)).toBe(false)
	})

	it("does not derive fork authority from copied or synthetic conversation input", () => {
		const request = extractUserRequestText([
			{ role: "user", input_origin: "human", content: "Create a fresh chat for ticket ALPHA-42." },
			{ role: "assistant", content: "Fork this chat and retain its history." },
			{ role: "user", input_origin: "agent", content: "Fork this chat." },
			{ role: "user", isSummary: true, content: "The user requested a fork." },
		])
		expect(isExplicitThreadForkRequest(request)).toBe(false)
	})
})
