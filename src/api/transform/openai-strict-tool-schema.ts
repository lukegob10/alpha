type JsonSchema = Record<string, any>

const isSchemaObject = (value: unknown): value is JsonSchema =>
	typeof value === "object" && value !== null && !Array.isArray(value)

const schemaAllowsNull = (schema: JsonSchema): boolean => {
	const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
	if (types.includes("null") || schema.const === null) return true
	return [schema.anyOf, schema.oneOf].some(
		(branches) =>
			Array.isArray(branches) && branches.some((branch) => isSchemaObject(branch) && schemaAllowsNull(branch)),
	)
}

const makeNullable = (schema: JsonSchema): JsonSchema => {
	if (schemaAllowsNull(schema)) return schema

	if (typeof schema.type === "string" || Array.isArray(schema.type)) {
		const types = Array.isArray(schema.type) ? [...schema.type] : [schema.type]
		const result: JsonSchema = { ...schema, type: [...types, "null"] }
		if (Array.isArray(schema.enum) && !schema.enum.includes(null)) {
			result.enum = [...schema.enum, null]
		}
		return result
	}

	if (Array.isArray(schema.anyOf)) {
		return { ...schema, anyOf: [...schema.anyOf, { type: "null" }] }
	}

	return { anyOf: [schema, { type: "null" }] }
}

const normalizeSchemaNode = (schema: unknown): unknown => {
	if (!isSchemaObject(schema)) return schema

	const result: JsonSchema = { ...schema }
	for (const keyword of ["anyOf", "oneOf", "allOf"] as const) {
		if (Array.isArray(schema[keyword])) {
			result[keyword] = schema[keyword].map(normalizeSchemaNode)
		}
	}

	for (const keyword of ["$defs", "definitions"] as const) {
		if (isSchemaObject(schema[keyword])) {
			result[keyword] = Object.fromEntries(
				Object.entries(schema[keyword]).map(([key, value]) => [key, normalizeSchemaNode(value)]),
			)
		}
	}

	if (schema.items !== undefined) {
		result.items = Array.isArray(schema.items)
			? schema.items.map(normalizeSchemaNode)
			: normalizeSchemaNode(schema.items)
	}

	const isObjectSchema =
		schema.type === "object" ||
		(Array.isArray(schema.type) && schema.type.includes("object")) ||
		isSchemaObject(schema.properties)
	if (!isObjectSchema) return result

	result.additionalProperties = false
	if (!isSchemaObject(schema.properties)) return result

	const originallyRequired = new Set(Array.isArray(schema.required) ? schema.required : [])
	const entries = Object.entries(schema.properties).map(([key, value]) => {
		const normalized = normalizeSchemaNode(value)
		return [key, originallyRequired.has(key) || !isSchemaObject(normalized) ? normalized : makeNullable(normalized)]
	})
	result.properties = Object.fromEntries(entries)
	result.required = entries.map(([key]) => key)
	return result
}

/** Convert an existing function schema to the strict subset used by OpenAI Responses. */
export const toOpenAiStrictToolSchema = (schema: unknown): unknown => normalizeSchemaNode(schema)
