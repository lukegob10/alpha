import { describe, expect, it } from "vitest"

import { editorChatStateSchema } from "../editor-chat-state.js"

describe("editor chat persisted identity", () => {
	it.each([{ type: "newTaskDraft" }, { type: "task", taskId: "saved-task_1" }])(
		"accepts a versioned $type identity",
		(currentView) => {
			const state = { version: 1, currentView }
			expect(editorChatStateSchema.parse(state)).toEqual(state)
		},
	)

	it.each([undefined, null, {}, { version: 2, currentView: { type: "newTaskDraft" } }])(
		"rejects missing or unsupported state %j",
		(state) => expect(editorChatStateSchema.safeParse(state).success).toBe(false),
	)

	it.each(["", " ", ".", "..", "../task", "..\\task", "/task", "C:task", "task\0tail", "x".repeat(257)])(
		"rejects invalid task identity %j",
		(taskId) => {
			expect(editorChatStateSchema.safeParse({ version: 1, currentView: { type: "task", taskId } }).success).toBe(
				false,
			)
		},
	)

	it("does not accept runtime or authority fields in panel identity", () => {
		expect(
			editorChatStateSchema.safeParse({
				version: 1,
				currentView: { type: "task", taskId: "saved-task", approvalMode: "bypass" },
			}).success,
		).toBe(false)
	})
})
