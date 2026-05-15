import {
	loadAlphaLastModelSelection,
	ALPHA_LAST_MODEL_SELECTION_KEY,
	saveAlphaLastModelSelection,
} from "../alpha-last-model-selection"

class LocalStorageMock implements Storage {
	private store = new Map<string, string>()

	get length(): number {
		return this.store.size
	}

	clear(): void {
		this.store.clear()
	}

	getItem(key: string): string | null {
		return this.store.get(key) ?? null
	}

	key(index: number): string | null {
		return Array.from(this.store.keys())[index] ?? null
	}

	removeItem(key: string): void {
		this.store.delete(key)
	}

	setItem(key: string, value: string): void {
		this.store.set(key, value)
	}
}

beforeEach(() => {
	Object.defineProperty(globalThis, "localStorage", {
		value: new LocalStorageMock(),
		configurable: true,
	})
})

describe("alpha-last-model-selection", () => {
	it("saves and loads (deduped + trimmed)", () => {
		saveAlphaLastModelSelection([" roo/model-a ", "roo/model-a", "roo/model-b"])
		expect(loadAlphaLastModelSelection()).toEqual(["roo/model-a", "roo/model-b"])
	})

	it("ignores invalid JSON", () => {
		localStorage.setItem(ALPHA_LAST_MODEL_SELECTION_KEY, "{this is not json")
		expect(loadAlphaLastModelSelection()).toEqual([])
	})

	it("clears when empty", () => {
		localStorage.setItem(ALPHA_LAST_MODEL_SELECTION_KEY, JSON.stringify(["roo/model-a"]))
		saveAlphaLastModelSelection([])
		expect(localStorage.getItem(ALPHA_LAST_MODEL_SELECTION_KEY)).toBeNull()
	})

	it("does not throw if localStorage access fails", () => {
		Object.defineProperty(globalThis, "localStorage", {
			value: {
				getItem: () => {
					throw new Error("blocked")
				},
				setItem: () => {
					throw new Error("blocked")
				},
				removeItem: () => {
					throw new Error("blocked")
				},
			},
			configurable: true,
		})

		expect(() => loadAlphaLastModelSelection()).not.toThrow()
		expect(() => saveAlphaLastModelSelection(["roo/model-a"])).not.toThrow()
	})
})
