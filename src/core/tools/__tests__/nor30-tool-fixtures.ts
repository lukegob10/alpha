import { formatNative, customToolRegistry } from "@alpha-code/core"
import type { CustomToolDefinition } from "@alpha-code/types"
import type OpenAI from "openai"
import { vi } from "vitest"

import { createAgentResponse, type AgentResponseItem } from "../../agent/AgentResponse"
import { ToolScheduler, type ToolExecutionHost, type ToolSchedulerOptions } from "../../agent/ToolScheduler"
import { createTaskToolSurface, type TaskToolSurface } from "../TaskToolSurface"
import { ToolRegistry, type ToolCapabilities, type ToolDescriptor } from "../ToolRegistry"
import type { Task } from "../../task/Task"

export type Nor30ToolCall = {
	id: string
	name: string
	arguments?: unknown
}

export function functionSchema(name: string): OpenAI.Chat.ChatCompletionFunctionTool {
	return {
		type: "function",
		function: {
			name,
			description: `${name} NOR-30 fixture`,
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	}
}

export function fixtureDescriptor(
	name: string,
	execute: ToolDescriptor["execute"],
	capabilities: Partial<ToolCapabilities> = {},
): ToolDescriptor {
	return {
		name,
		aliases: [],
		schema: functionSchema(name),
		capabilities: {
			concurrency: "serial",
			sideEffects: "none",
			controlFlow: false,
			requiresApproval: false,
			...capabilities,
		},
		execute,
	}
}

export function fixtureRegistry(...descriptors: ToolDescriptor[]): ToolRegistry {
	const registry = new ToolRegistry({ includeBuiltIns: false })
	for (const descriptor of descriptors) registry.register(descriptor)
	return registry
}

export function response(...calls: Nor30ToolCall[]) {
	const items: AgentResponseItem[] = calls.map((call) => ({
		type: "tool_call",
		id: call.id,
		name: call.name,
		arguments: call.arguments === undefined ? {} : call.arguments,
	}))
	return createAgentResponse(items)
}

export function registerCustomTool(definition: CustomToolDefinition): {
	schema: OpenAI.Chat.ChatCompletionFunctionTool
	cleanup: () => void
} {
	customToolRegistry.register(definition)
	const serialized = customToolRegistry.getAllSerialized().find((tool) => tool.name === definition.name)
	if (!serialized) throw new Error(`Custom NOR-30 fixture "${definition.name}" was not serialized.`)

	return {
		schema: formatNative(serialized),
		cleanup: () => {
			customToolRegistry.unregister(definition.name)
		},
	}
}

export function capturedSurface(
	registry: ToolRegistry,
	options: {
		schemas?: readonly OpenAI.Chat.ChatCompletionTool[]
		mode?: string
		profile?: string
		visibleToolNames?: readonly string[]
		allowedToolNames?: readonly string[]
		disabledTools?: readonly string[]
		includeAllToolsWithRestrictions?: boolean
	} = {},
): TaskToolSurface {
	const schemas = options.schemas ?? registry.getSchemas()
	return createTaskToolSurface({
		registry,
		schemas,
		mode: options.mode ?? "code",
		profile: options.profile,
		visibleToolNames: options.visibleToolNames,
		allowedToolNames: options.allowedToolNames,
		disabledTools: options.disabledTools,
		includeAllToolsWithRestrictions: options.includeAllToolsWithRestrictions,
	})
}

export function makeExecutionHost(
	options: {
		taskMode?: string
		provider?: unknown
		approval?: { response: string; text?: string; images?: string[] }
	} = {},
) {
	type UserMessageContent = ToolExecutionHost["userMessageContent"]
	const userMessageContent: UserMessageContent = []
	const host = {
		taskId: "nor30-task",
		cwd: process.cwd(),
		abort: false,
		didToolFailInCurrentTurn: false,
		userMessageContent,
		userMessageContentReady: false,
		consecutiveMistakeCount: 0,
		lastMessageTs: 30,
		providerRef: { deref: vi.fn(() => options.provider) },
		getTaskMode: vi.fn(async () => options.taskMode ?? "code"),
		ask: vi.fn(async () => options.approval ?? { response: "yesButtonClicked" }),
		say: vi.fn(async () => undefined),
		recordToolUsage: vi.fn(),
		recordToolError: vi.fn(),
		pushToolResultToUserContent(result: Parameters<ToolExecutionHost["pushToolResultToUserContent"]>[0]) {
			if (
				userMessageContent.some(
					(item) => item.type === "tool_result" && item.tool_use_id === result.tool_use_id,
				)
			) {
				return false
			}
			userMessageContent.push(result)
			return true
		},
	}

	return {
		host: host as unknown as ToolExecutionHost,
		task: host as unknown as Task,
		userMessageContent,
	}
}

export type Nor30Harness = ReturnType<typeof makeExecutionHost>

export type Nor30RunOptions = Pick<
	ToolSchedulerOptions,
	"customModes" | "experiments" | "disabledTools" | "includedTools" | "validateCall" | "onEvent" | "executionMode"
> & {
	mode?: string
}

export async function runToolCalls(
	harness: Nor30Harness,
	surface: TaskToolSurface,
	calls: readonly Nor30ToolCall[],
	options: Nor30RunOptions = {},
) {
	const { mode = "code", ...schedulerOptions } = options
	const scheduler = new ToolScheduler({
		task: harness.task,
		executionHost: harness.host,
		registry: surface.registry,
		policy: surface.policy,
		mode,
		...schedulerOptions,
	})
	return scheduler.run(response(...calls))
}

type UserMessageItem = ToolExecutionHost["userMessageContent"][number]
type ToolResultItem = Extract<UserMessageItem, { type: "tool_result" }>
type ImageResultItem = Extract<UserMessageItem, { type: "image" }>

function isToolResult(item: UserMessageItem): item is ToolResultItem {
	return item.type === "tool_result"
}

function isImageResult(item: UserMessageItem): item is ImageResultItem {
	return item.type === "image"
}

export function toolResults(harness: Nor30Harness): ToolResultItem[] {
	return harness.userMessageContent.filter(isToolResult)
}

export function imageResults(harness: Nor30Harness): ImageResultItem[] {
	return harness.userMessageContent.filter(isImageResult)
}
