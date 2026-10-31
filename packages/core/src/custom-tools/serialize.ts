import { type SerializedCustomToolDefinition, parametersSchema } from "@alpha-code/types"

import type { StoredCustomTool } from "./types.js"

export function serializeCustomTool({
	name,
	description,
	parameters,
	source,
}: StoredCustomTool): SerializedCustomToolDefinition {
	return {
		name,
		description,
		// The model supplies parser input; local transforms and defaults produce executor output.
		parameters: parameters ? parametersSchema.toJSONSchema(parameters, { io: "input" }) : undefined,
		source,
	}
}

export function serializeCustomTools(tools: StoredCustomTool[]): SerializedCustomToolDefinition[] {
	return tools.map(serializeCustomTool)
}
