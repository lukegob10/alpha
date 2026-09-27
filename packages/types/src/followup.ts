import { z } from "zod"

/**
 * Interface for follow-up data structure used in follow-up questions
 * This represents the data structure for follow-up questions that the LLM can ask
 * to gather more information needed to complete a task.
 */
export interface FollowUpData {
	/** The question being asked by the LLM */
	question?: string
	/** Array of suggested answers that the user can select */
	suggest?: Array<SuggestionItem>
	/** A native grouped request_user_input payload. */
	requestUserInput?: RequestUserInputData
}

export interface RequestUserInputOption {
	label: string
	description: string
}

export interface RequestUserInputQuestion {
	id: string
	header: string
	question: string
	options: RequestUserInputOption[]
}

export interface RequestUserInputData {
	questions: RequestUserInputQuestion[]
}

export interface RequestUserInputAnswer {
	answers: string[]
}

export type RequestUserInputAnswerMap = Record<string, RequestUserInputAnswer>

/** Nonblocking user questions requested during an active task turn. */
export interface AsyncUserInputQuestion {
	title: string
	options?: string[]
}

export interface AsyncUserInputData {
	questions: AsyncUserInputQuestion[]
}

/**
 * Interface for a suggestion item with optional mode switching
 */
export interface SuggestionItem {
	/** The text of the suggestion */
	answer: string
	/** Optional mode to switch to when selecting this suggestion */
	mode?: string
}

/**
 * Zod schema for SuggestionItem
 */
export const suggestionItemSchema = z.object({
	answer: z.string(),
	mode: z.string().optional(),
})

export const requestUserInputOptionSchema = z.object({
	label: z.string(),
	description: z.string(),
})

export const requestUserInputQuestionSchema = z.object({
	id: z.string(),
	header: z.string(),
	question: z.string(),
	options: z.array(requestUserInputOptionSchema),
})

export const requestUserInputDataSchema = z.object({
	questions: z.array(requestUserInputQuestionSchema),
})

export const asyncUserInputQuestionSchema = z.object({
	title: z.string().trim().min(1),
	options: z.array(z.string().trim().min(1)).min(1).optional(),
})

export const asyncUserInputDataSchema = z.object({
	questions: z.array(asyncUserInputQuestionSchema).min(1),
})

/**
 * Zod schema for FollowUpData
 */
export const followUpDataSchema = z.object({
	question: z.string().optional(),
	suggest: z.array(suggestionItemSchema).optional(),
	requestUserInput: requestUserInputDataSchema.optional(),
})

export type FollowUpDataType = z.infer<typeof followUpDataSchema>
