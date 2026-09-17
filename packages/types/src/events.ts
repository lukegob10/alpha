import { z } from "zod"

import { alphaMessageSchema, queuedMessageSchema, tokenUsageSchema } from "./message.js"
import { modelInfoSchema } from "./model.js"
import { toolNamesSchema, toolUsageSchema } from "./tool.js"

/**
 * AlphaCodeEventName
 */

export enum AlphaCodeEventName {
	// Task Provider Lifecycle
	TaskCreated = "taskCreated",

	// Task Lifecycle
	TaskStarted = "taskStarted",
	TaskCompleted = "taskCompleted",
	TaskAborted = "taskAborted",
	TaskFocused = "taskFocused",
	TaskUnfocused = "taskUnfocused",
	TaskActive = "taskActive",
	TaskInteractive = "taskInteractive",
	TaskResumable = "taskResumable",
	TaskIdle = "taskIdle",

	// Subtask Lifecycle
	TaskPaused = "taskPaused",
	TaskUnpaused = "taskUnpaused",
	TaskSpawned = "taskSpawned",
	TaskDelegated = "taskDelegated",
	TaskDelegationCompleted = "taskDelegationCompleted",
	TaskDelegationResumed = "taskDelegationResumed",

	// Task Execution
	Message = "message",
	TaskModeSwitched = "taskModeSwitched",
	TaskAskResponded = "taskAskResponded",
	TaskUserMessage = "taskUserMessage",
	QueuedMessagesUpdated = "queuedMessagesUpdated",

	// Task Analytics
	TaskTokenUsageUpdated = "taskTokenUsageUpdated",
	TaskToolFailed = "taskToolFailed",

	// Configuration Changes
	ModeChanged = "modeChanged",
	ProviderProfileChanged = "providerProfileChanged",

	// Query Responses
	CommandsResponse = "commandsResponse",
	ModesResponse = "modesResponse",
	ModelsResponse = "modelsResponse",

	// Evals
	EvalPass = "evalPass",
	EvalFail = "evalFail",
}

/**
 * AlphaCodeEvents
 */

export const alphaCodeEventsSchema = z.object({
	[AlphaCodeEventName.TaskCreated]: z.tuple([z.string()]),

	[AlphaCodeEventName.TaskStarted]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskCompleted]: z.tuple([
		z.string(),
		tokenUsageSchema,
		toolUsageSchema,
		z.object({
			isSubtask: z.boolean(),
		}),
	]),
	[AlphaCodeEventName.TaskAborted]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskFocused]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskUnfocused]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskActive]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskInteractive]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskResumable]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskIdle]: z.tuple([z.string()]),

	[AlphaCodeEventName.TaskPaused]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskUnpaused]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskSpawned]: z.tuple([z.string(), z.string()]),
	[AlphaCodeEventName.TaskDelegated]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
	]),
	[AlphaCodeEventName.TaskDelegationCompleted]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
		z.string(), // completionResultSummary
	]),
	[AlphaCodeEventName.TaskDelegationResumed]: z.tuple([
		z.string(), // parentTaskId
		z.string(), // childTaskId
	]),

	[AlphaCodeEventName.Message]: z.tuple([
		z.object({
			taskId: z.string(),
			action: z.union([z.literal("created"), z.literal("updated")]),
			message: alphaMessageSchema,
		}),
	]),
	[AlphaCodeEventName.TaskModeSwitched]: z.tuple([z.string(), z.string()]),
	[AlphaCodeEventName.TaskAskResponded]: z.tuple([z.string()]),
	[AlphaCodeEventName.TaskUserMessage]: z.tuple([z.string()]),
	[AlphaCodeEventName.QueuedMessagesUpdated]: z.tuple([z.string(), z.array(queuedMessageSchema)]),

	[AlphaCodeEventName.TaskToolFailed]: z.tuple([z.string(), toolNamesSchema, z.string()]),
	[AlphaCodeEventName.TaskTokenUsageUpdated]: z.tuple([z.string(), tokenUsageSchema, toolUsageSchema]),

	[AlphaCodeEventName.ModeChanged]: z.tuple([z.string()]),
	[AlphaCodeEventName.ProviderProfileChanged]: z.tuple([z.object({ name: z.string(), provider: z.string() })]),

	[AlphaCodeEventName.CommandsResponse]: z.tuple([
		z.array(
			z.object({
				name: z.string(),
				source: z.enum(["global", "project", "built-in"]),
				filePath: z.string().optional(),
				description: z.string().optional(),
				argumentHint: z.string().optional(),
			}),
		),
	]),
	[AlphaCodeEventName.ModesResponse]: z.tuple([z.array(z.object({ slug: z.string(), name: z.string() }))]),
	[AlphaCodeEventName.ModelsResponse]: z.tuple([z.record(z.string(), modelInfoSchema)]),
})

export type AlphaCodeEvents = z.infer<typeof alphaCodeEventsSchema>

/**
 * TaskEvent
 */

export const taskEventSchema = z.discriminatedUnion("eventName", [
	// Task Provider Lifecycle
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskCreated),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskCreated],
		taskId: z.number().optional(),
	}),

	// Task Lifecycle
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskStarted),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskStarted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskCompleted),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskCompleted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskAborted),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskAborted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskFocused),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskFocused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskUnfocused),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskUnfocused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskActive),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskActive],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskInteractive),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskInteractive],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskResumable),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskResumable],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskIdle),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskIdle],
		taskId: z.number().optional(),
	}),

	// Subtask Lifecycle
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskPaused),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskPaused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskUnpaused),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskUnpaused],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskSpawned),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskSpawned],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskDelegated),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskDelegated],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskDelegationCompleted),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskDelegationCompleted],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskDelegationResumed),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskDelegationResumed],
		taskId: z.number().optional(),
	}),

	// Task Execution
	z.object({
		eventName: z.literal(AlphaCodeEventName.Message),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.Message],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskModeSwitched),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskModeSwitched],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskAskResponded),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskAskResponded],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.QueuedMessagesUpdated),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.QueuedMessagesUpdated],
		taskId: z.number().optional(),
	}),

	// Task Analytics
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskToolFailed),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskToolFailed],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.TaskTokenUsageUpdated),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.TaskTokenUsageUpdated],
		taskId: z.number().optional(),
	}),

	// Query Responses
	z.object({
		eventName: z.literal(AlphaCodeEventName.CommandsResponse),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.CommandsResponse],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.ModesResponse),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.ModesResponse],
		taskId: z.number().optional(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.ModelsResponse),
		payload: alphaCodeEventsSchema.shape[AlphaCodeEventName.ModelsResponse],
		taskId: z.number().optional(),
	}),

	// Evals
	z.object({
		eventName: z.literal(AlphaCodeEventName.EvalPass),
		payload: z.undefined(),
		taskId: z.number(),
	}),
	z.object({
		eventName: z.literal(AlphaCodeEventName.EvalFail),
		payload: z.undefined(),
		taskId: z.number(),
	}),
])

export type TaskEvent = z.infer<typeof taskEventSchema>

/** @deprecated Use AlphaCodeEventName. Retained for existing API consumers. */
export { AlphaCodeEventName as RooCodeEventName }

/** @deprecated Use alphaCodeEventsSchema. Retained for existing API consumers. */
export { alphaCodeEventsSchema as rooCodeEventsSchema }

/** @deprecated Use AlphaCodeEvents. Retained for existing API consumers. */
export type { AlphaCodeEvents as RooCodeEvents }
