/** VS Code provider state, kept separate from visible reasoning and other providers' signatures. */
export interface VscodeLmThinking {
	value: string | string[]
	id?: string
	metadata?: Record<string, unknown>
	/** Alpha provenance; never passed as host thinking metadata. Absent in legacy history. */
	modelId?: string
	modelVendor?: string
	modelVersion?: string
}

export interface VscodeLmThinkingHistoryBlock extends VscodeLmThinking {
	type: "vscode_lm_thinking"
}

// Metadata is small wire state. Bound validation of untrusted persisted/provider
// objects before serialization, including cycles and excessively nested values.
function isJsonMetadata(value: unknown): value is Record<string, unknown> {
	let remaining = 100_000
	const visit = (item: unknown, depth: number): boolean => {
		if (--remaining < 0 || depth > 64) return false
		if (item === null || typeof item === "string" || typeof item === "boolean") return true
		if (typeof item === "number") return Number.isFinite(item)
		if (!item || typeof item !== "object") return false
		if (Array.isArray(item)) {
			if (item.length > remaining) return false
			for (let index = 0; index < item.length; index++) {
				if (!Object.hasOwn(item, index) || !visit(item[index], depth + 1)) return false
			}
			return true
		}
		const prototype: unknown = Object.getPrototypeOf(item)
		if (prototype !== Object.prototype && prototype !== null) return false
		if (typeof (item as { toJSON?: unknown }).toJSON === "function") return false
		for (const key in item) {
			if (!Object.hasOwn(item, key)) continue
			const entry: unknown = (item as Record<string, unknown>)[key]
			if (entry !== undefined && !visit(entry, depth + 1)) return false
		}
		return true
	}
	return !!value && typeof value === "object" && !Array.isArray(value) && visit(value, 0)
}

/**
 * Snapshot the JSON wire payload without interpreting its opaque metadata. Reject
 * non-serializable state rather than persisting a silently altered signature.
 */
export function snapshotVscodeLmThinking(value: unknown): VscodeLmThinking | undefined {
	try {
		if (!value || typeof value !== "object") return undefined
		const part = value as Record<string, unknown>
		const rawValue = part.value
		let thinkingValue: string | string[]
		if (typeof rawValue === "string") {
			thinkingValue = rawValue
		} else if (Array.isArray(rawValue) && rawValue.length <= 100_000) {
			for (const entry of rawValue) if (typeof entry !== "string") return undefined
			thinkingValue = [...rawValue]
		} else {
			return undefined
		}
		if (part.id !== undefined && typeof part.id !== "string") return undefined
		if (part.modelId !== undefined && typeof part.modelId !== "string") return undefined
		if (part.modelVendor !== undefined && typeof part.modelVendor !== "string") return undefined
		if (part.modelVersion !== undefined && typeof part.modelVersion !== "string") return undefined
		const snapshot: VscodeLmThinking = {
			value: thinkingValue,
			...(part.id !== undefined ? { id: part.id } : {}),
			...(part.modelId !== undefined ? { modelId: part.modelId } : {}),
			...(part.modelVendor !== undefined ? { modelVendor: part.modelVendor } : {}),
			...(part.modelVersion !== undefined ? { modelVersion: part.modelVersion } : {}),
		}
		if (part.metadata !== undefined) {
			if (!isJsonMetadata(part.metadata)) return undefined
			// Undefined object properties follow the host's JSON wire semantics.
			snapshot.metadata = JSON.parse(JSON.stringify(part.metadata)) as Record<string, unknown>
		}
		return snapshot
	} catch {
		return undefined
	}
}
