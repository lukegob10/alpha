import { z } from "zod"

import { taskIdSchema } from "./agent-lifecycle.js"

/** Editor panel identity only; task state and execution authority stay in the extension. */
export const editorChatStateSchema = z
	.object({
		version: z.literal(1),
		currentView: z.discriminatedUnion("type", [
			z.object({ type: z.literal("newTaskDraft") }).strict(),
			z
				.object({
					type: z.literal("task"),
					taskId: taskIdSchema.refine(
						(value) => !/[\\/:\0]/.test(value) && value !== "." && value !== "..",
						"Task identity must be a portable path component",
					),
				})
				.strict(),
		]),
	})
	.strict()

export type EditorChatState = z.infer<typeof editorChatStateSchema>
