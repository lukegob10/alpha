import { renderHook, act } from "@/utils/test-utils"

import type { HistoryItem } from "@alpha-code/types"
import type { FzfOptions } from "fzf"

import { useTaskSearch } from "../useTaskSearch"

const fzfOperations = vi.hoisted(() => ({ indexes: 0, indexedItems: 0, searches: 0 }))

vi.mock("fzf", async (importOriginal) => {
	const actual = await importOriginal<typeof import("fzf")>()
	return {
		...actual,
		Fzf: class extends actual.Fzf<HistoryItem[]> {
			constructor(items: HistoryItem[], options: FzfOptions<HistoryItem>) {
				super(items, {
					...options,
					selector: (item) => {
						fzfOperations.indexedItems++
						return options.selector(item)
					},
				})
				fzfOperations.indexes++
				const find = this.find
				this.find = (query) => {
					fzfOperations.searches++
					return find(query)
				}
			}
		},
	}
})

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: vi.fn(),
}))

vi.mock("@/utils/highlight", () => ({
	highlightFzfMatch: vi.fn((text) => `<mark>${text}</mark>`),
}))

import { useExtensionState } from "@/context/ExtensionStateContext"
import { highlightFzfMatch } from "@/utils/highlight"

const mockUseExtensionState = useExtensionState as import("vitest").Mock

const mockTaskHistory: HistoryItem[] = [
	{
		id: "task-1",
		number: 1,
		task: "Create a React component",
		ts: new Date("2022-02-16T12:00:00").getTime(),
		tokensIn: 100,
		tokensOut: 50,
		totalCost: 0.01,
		workspace: "/workspace/project1",
	},
	{
		id: "task-2",
		number: 2,
		task: "Write unit tests",
		ts: new Date("2022-02-17T12:00:00").getTime(),
		tokensIn: 200,
		tokensOut: 100,
		totalCost: 0.02,
		cacheWrites: 25,
		cacheReads: 10,
		workspace: "/workspace/project1",
	},
	{
		id: "task-3",
		number: 3,
		task: "Fix bug in authentication",
		ts: new Date("2022-02-15T12:00:00").getTime(),
		tokensIn: 150,
		tokensOut: 75,
		totalCost: 0.05,
		workspace: "/workspace/project1",
	},
]

describe("useTaskSearch", () => {
	beforeEach(() => {
		vi.clearAllMocks()
		fzfOperations.indexes = 0
		fzfOperations.indexedItems = 0
		fzfOperations.searches = 0
		mockUseExtensionState.mockReturnValue({
			taskHistory: mockTaskHistory,
			cwd: "/workspace/project1",
		} as any)
	})

	it("defers indexing a large changing history until search and reuses its index between queries", () => {
		let history = Array.from({ length: 10_000 }, (_, index) => ({
			...mockTaskHistory[0],
			id: `task-${index}`,
			ts: mockTaskHistory[0].ts - index,
		}))
		mockUseExtensionState.mockReturnValue({ taskHistory: history })
		const { result, rerender } = renderHook(() => useTaskSearch())

		for (let update = 0; update < 20; update++) {
			history = history.map((item, index) => (index === 0 ? { ...item, tokensOut: update } : item))
			mockUseExtensionState.mockReturnValue({ taskHistory: history })
			rerender()
		}

		expect(result.current.tasks).toHaveLength(10_000)
		expect(fzfOperations).toEqual({ indexes: 0, indexedItems: 0, searches: 0 })

		act(() => result.current.setSearchQuery("React"))
		expect(result.current.tasks).toHaveLength(10_000)
		expect(fzfOperations).toEqual({ indexes: 1, indexedItems: 10_000, searches: 1 })

		act(() => result.current.setSearchQuery("component"))
		expect(result.current.tasks).toHaveLength(10_000)
		expect(fzfOperations).toEqual({ indexes: 1, indexedItems: 10_000, searches: 2 })
	})

	it("sorts cached search matches without repeating fuzzy scans or highlights", () => {
		const history = Object.freeze(
			mockTaskHistory.map((item) => Object.freeze({ ...item, task: `Shared topic ${item.id}` })),
		)
		mockUseExtensionState.mockReturnValue({ taskHistory: history })
		const { result } = renderHook(() => useTaskSearch())
		act(() => {
			result.current.setSearchQuery("Shared")
			result.current.setSortOption("mostRelevant")
		})
		const relevanceResults = result.current.tasks
		const relevanceOrder = relevanceResults.map((item) => item.id)
		expect(fzfOperations.searches).toBe(1)
		expect(highlightFzfMatch).toHaveBeenCalledTimes(history.length)

		for (const [sort, expected] of [
			["oldest", ["task-3", "task-1", "task-2"]],
			["mostTokens", ["task-2", "task-3", "task-1"]],
			["mostExpensive", ["task-3", "task-2", "task-1"]],
			["newest", ["task-2", "task-1", "task-3"]],
			["mostRelevant", relevanceOrder],
		] as const) {
			act(() => result.current.setSortOption(sort))
			expect(result.current.tasks.map((item) => item.id)).toEqual(expected)
			expect(relevanceResults.map((item) => item.id)).toEqual(relevanceOrder)
		}

		expect(fzfOperations).toEqual({ indexes: 1, indexedItems: history.length, searches: 1 })
		expect(highlightFzfMatch).toHaveBeenCalledTimes(history.length)
		expect(history.map((item) => item.id)).toEqual(["task-1", "task-2", "task-3"])
	})

	it("refreshes active search matches and metadata when titles or projected records change", () => {
		mockUseExtensionState.mockReturnValue({
			taskHistory: [{ ...mockTaskHistory[0], generatedTitle: "Navigation cleanup" }],
		})
		const { result, rerender } = renderHook(() => useTaskSearch())
		act(() => result.current.setSearchQuery("Navigation"))
		expect(result.current.tasks.map((item) => item.id)).toEqual(["task-1"])

		mockUseExtensionState.mockReturnValue({
			taskHistory: [
				{ ...mockTaskHistory[0], generatedTitle: "Storage cleanup", tokensOut: 999 },
				{ ...mockTaskHistory[1], id: "new-task", task: "Navigation audit", archived: true },
			],
		})
		rerender()
		expect(result.current.tasks).toMatchObject([{ id: "new-task", archived: true }])

		act(() => result.current.setSearchQuery("Storage"))
		expect(result.current.tasks).toMatchObject([
			{ id: "task-1", generatedTitle: "Storage cleanup", tokensOut: 999 },
		])
		expect(fzfOperations).toEqual({ indexes: 2, indexedItems: 3, searches: 3 })
	})

	it("indexes the latest history when search resumes after a closed-history update", () => {
		const { result, rerender } = renderHook(() => useTaskSearch())
		act(() => result.current.setSearchQuery("React"))
		act(() => result.current.setSearchQuery(""))
		mockUseExtensionState.mockReturnValue({
			taskHistory: [{ ...mockTaskHistory[1], id: "latest-task", task: "Latest conversation" }],
		})
		rerender()
		expect(fzfOperations.indexes).toBe(1)

		act(() => result.current.setSearchQuery("Latest"))
		expect(result.current.tasks.map((item) => item.id)).toEqual(["latest-task"])
		expect(fzfOperations).toEqual({ indexes: 2, indexedItems: 4, searches: 2 })
	})

	it("returns the projected project tasks by default", () => {
		const { result } = renderHook(() => useTaskSearch())

		expect(result.current.tasks).toHaveLength(3)
		expect(result.current.tasks[0].id).toBe("task-2") // Newest first
		expect(result.current.tasks[1].id).toBe("task-1")
		expect(result.current.tasks[2].id).toBe("task-3")
	})

	it("keeps the project history supplied by the extension", () => {
		const { result } = renderHook(() => useTaskSearch())

		expect(result.current.tasks).toHaveLength(3)
		expect(result.current.tasks.every((task) => task.workspace === "/workspace/project1")).toBe(true)
	})

	it("sorts by newest by default", () => {
		const { result } = renderHook(() => useTaskSearch())

		expect(result.current.sortOption).toBe("newest")
		expect(result.current.tasks[0].id).toBe("task-2") // Feb 17
		expect(result.current.tasks[1].id).toBe("task-1") // Feb 16
		expect(result.current.tasks[2].id).toBe("task-3") // Feb 15
	})

	it("sorts by oldest", () => {
		const { result } = renderHook(() => useTaskSearch())

		act(() => {
			result.current.setSortOption("oldest")
		})

		expect(result.current.tasks[0].id).toBe("task-3") // Feb 15
		expect(result.current.tasks[1].id).toBe("task-1") // Feb 16
		expect(result.current.tasks[2].id).toBe("task-2") // Feb 17
	})

	it("sorts by most expensive", () => {
		const { result } = renderHook(() => useTaskSearch())

		act(() => {
			result.current.setSortOption("mostExpensive")
		})

		expect(result.current.tasks[0].id).toBe("task-3") // $0.05
		expect(result.current.tasks[1].id).toBe("task-2") // $0.02
		expect(result.current.tasks[2].id).toBe("task-1") // $0.01
	})

	it("sorts by most tokens", () => {
		const { result } = renderHook(() => useTaskSearch())

		act(() => {
			result.current.setSortOption("mostTokens")
		})

		// task-2: 200 + 100 + 25 + 10 = 335 tokens
		// task-3: 150 + 75 = 225 tokens
		// task-1: 100 + 50 = 150 tokens
		expect(result.current.tasks[0].id).toBe("task-2")
		expect(result.current.tasks[1].id).toBe("task-3")
		expect(result.current.tasks[2].id).toBe("task-1")
	})

	it("filters tasks by search query", () => {
		const { result } = renderHook(() => useTaskSearch())

		act(() => {
			result.current.setSearchQuery("React")
		})

		expect(result.current.tasks).toHaveLength(1)
		expect(result.current.tasks[0].id).toBe("task-1")
		expect((result.current.tasks[0] as any).highlight).toBe("<mark>Create a React component</mark>")
	})

	it("finds generated titles and original prompts without changing the displayed title", () => {
		mockUseExtensionState.mockReturnValue({
			taskHistory: [{ ...mockTaskHistory[0], generatedTitle: "Navigation cleanup" }],
		})
		const { result } = renderHook(() => useTaskSearch())
		act(() => result.current.setSearchQuery("Navigation"))
		expect(result.current.tasks).toHaveLength(1)
		expect(result.current.tasks[0]).toMatchObject({
			generatedTitle: "Navigation cleanup",
			task: "Create a React component",
			highlight: "<mark>Navigation cleanup</mark>",
		})
		act(() => result.current.setSearchQuery("React"))
		expect(result.current.tasks).toHaveLength(1)
		expect(result.current.tasks[0].task).toBe("Create a React component")
		expect(result.current.tasks[0].generatedTitle).toBe("Navigation cleanup")
	})

	it("does not inject unescaped custom names when only the original prompt matches", () => {
		mockUseExtensionState.mockReturnValue({
			taskHistory: [{ ...mockTaskHistory[0], task: "zzzzoriginal", displayName: "<img src=x>" }],
		})
		const { result } = renderHook(() => useTaskSearch())
		act(() => result.current.setSearchQuery("zzzzoriginal"))
		expect(result.current.tasks).toHaveLength(1)
		expect((result.current.tasks[0] as { highlight?: string }).highlight).toBeUndefined()
	})

	it("automatically switches to mostRelevant when searching", () => {
		const { result } = renderHook(() => useTaskSearch())

		// Initially lastNonRelevantSort should be "newest" (the default)
		expect(result.current.lastNonRelevantSort).toBe("newest")

		act(() => {
			result.current.setSortOption("oldest")
		})

		expect(result.current.sortOption).toBe("oldest")

		// Clear lastNonRelevantSort to test the auto-switch behavior
		act(() => {
			result.current.setLastNonRelevantSort(null)
		})

		act(() => {
			result.current.setSearchQuery("test")
		})

		// The hook should automatically switch to mostRelevant when there's a search query
		// and the current sort is not mostRelevant and lastNonRelevantSort is null
		expect(result.current.sortOption).toBe("mostRelevant")
		expect(result.current.lastNonRelevantSort).toBe("oldest")
	})

	it("restores previous sort when clearing search", () => {
		const { result } = renderHook(() => useTaskSearch())

		act(() => {
			result.current.setSortOption("mostExpensive")
		})

		expect(result.current.sortOption).toBe("mostExpensive")

		// Clear lastNonRelevantSort to enable the auto-switch behavior
		act(() => {
			result.current.setLastNonRelevantSort(null)
		})

		act(() => {
			result.current.setSearchQuery("test")
		})

		expect(result.current.sortOption).toBe("mostRelevant")
		expect(result.current.lastNonRelevantSort).toBe("mostExpensive")

		act(() => {
			result.current.setSearchQuery("")
		})

		expect(result.current.sortOption).toBe("mostExpensive")
		expect(result.current.lastNonRelevantSort).toBe(null)
	})

	it("handles empty task history", () => {
		mockUseExtensionState.mockReturnValue({
			taskHistory: [],
			cwd: "/workspace/project1",
		} as any)

		const { result } = renderHook(() => useTaskSearch())

		expect(result.current.tasks).toHaveLength(0)
	})

	it("filters out tasks without timestamp or task content", () => {
		const incompleteTaskHistory = [
			...mockTaskHistory,
			{
				id: "incomplete-1",
				number: 4,
				task: "",
				ts: Date.now(),
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			},
			{
				id: "incomplete-2",
				number: 5,
				task: "Valid task",
				ts: 0,
				tokensIn: 0,
				tokensOut: 0,
				totalCost: 0,
			},
		] as HistoryItem[]

		mockUseExtensionState.mockReturnValue({
			taskHistory: incompleteTaskHistory,
			cwd: "/workspace/project1",
		} as any)

		const { result } = renderHook(() => useTaskSearch())

		// Should only include tasks with both ts and task content
		expect(result.current.tasks).toHaveLength(3)
		expect(result.current.tasks.every((task) => task.ts && task.task)).toBe(true)
	})

	it("handles search with no results", () => {
		const { result } = renderHook(() => useTaskSearch())

		act(() => {
			result.current.setSearchQuery("nonexistent")
		})

		expect(result.current.tasks).toHaveLength(0)
	})

	it("preserves search results order when using mostRelevant sort", () => {
		const { result } = renderHook(() => useTaskSearch())

		act(() => {
			result.current.setSearchQuery("test")
			result.current.setSortOption("mostRelevant")
		})

		// When searching, mostRelevant should preserve fzf order
		// When not searching, it should fall back to newest
		expect(result.current.sortOption).toBe("mostRelevant")
	})
})
