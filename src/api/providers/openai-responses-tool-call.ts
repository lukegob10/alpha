export interface OpenAiResponsesToolCallIdentity {
	callId: string
	name?: string
	itemId?: string
	index?: number
}

function stringValue(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined
}

function numberValue(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined
}

/**
 * Associates Responses API argument events with the function-call output item
 * that owns them. Responses streams commonly provide `item_id` and
 * `output_index` on argument deltas, while `call_id` and `name` only appear on
 * response.output_item.added/done.
 */
export class OpenAiResponsesToolCallTracker {
	private readonly byItemId = new Map<string, OpenAiResponsesToolCallIdentity>()
	private readonly byIndex = new Map<number, OpenAiResponsesToolCallIdentity>()
	private latest?: OpenAiResponsesToolCallIdentity

	reset(): void {
		this.byItemId.clear()
		this.byIndex.clear()
		this.latest = undefined
	}

	remember(item: any, outputIndex?: unknown): OpenAiResponsesToolCallIdentity | undefined {
		const itemId = stringValue(item?.id) ?? stringValue(item?.item_id)
		const index = numberValue(outputIndex) ?? numberValue(item?.output_index) ?? numberValue(item?.index)
		const existingByItemId = itemId ? this.byItemId.get(itemId) : undefined
		const existing = existingByItemId ?? (index !== undefined ? this.byIndex.get(index) : undefined)
		const callId = stringValue(item?.call_id) ?? stringValue(item?.tool_call_id) ?? existing?.callId ?? itemId
		if (!callId) {
			return undefined
		}

		const identity: OpenAiResponsesToolCallIdentity = {
			callId,
			...((stringValue(item?.name) ?? stringValue(item?.function?.name) ?? stringValue(item?.function_name))
				? {
						name:
							stringValue(item?.name) ??
							stringValue(item?.function?.name) ??
							stringValue(item?.function_name),
					}
				: existing?.name
					? { name: existing.name }
					: {}),
			...(itemId ? { itemId } : existing?.itemId ? { itemId: existing.itemId } : {}),
			...(index !== undefined ? { index } : existing?.index !== undefined ? { index: existing.index } : {}),
		}

		if (identity.itemId) {
			this.byItemId.set(identity.itemId, identity)
		}
		if (identity.index !== undefined) {
			this.byIndex.set(identity.index, identity)
		}
		this.latest = identity
		return identity
	}

	resolve(event: any): OpenAiResponsesToolCallIdentity | undefined {
		const itemId = stringValue(event?.item_id) ?? stringValue(event?.itemId)
		const index = numberValue(event?.output_index) ?? numberValue(event?.index)
		const knownByItemId = itemId ? this.byItemId.get(itemId) : undefined
		const known = knownByItemId ?? (index !== undefined ? this.byIndex.get(index) : undefined)
		const callId =
			stringValue(event?.call_id) ??
			stringValue(event?.tool_call_id) ??
			known?.callId ??
			(itemId === undefined && index === undefined ? (stringValue(event?.id) ?? this.latest?.callId) : undefined)
		if (!callId) {
			return undefined
		}

		const name =
			stringValue(event?.name) ??
			stringValue(event?.function_name) ??
			known?.name ??
			(itemId === undefined && index === undefined ? this.latest?.name : undefined)
		const identity: OpenAiResponsesToolCallIdentity = {
			callId,
			...(name ? { name } : {}),
			...(itemId ? { itemId } : known?.itemId ? { itemId: known.itemId } : {}),
			...(index !== undefined ? { index } : known?.index !== undefined ? { index: known.index } : {}),
		}

		if (identity.itemId) {
			this.byItemId.set(identity.itemId, identity)
		}
		if (identity.index !== undefined) {
			this.byIndex.set(identity.index, identity)
		}
		this.latest = identity
		return identity
	}
}
