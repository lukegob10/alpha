import React from "react"
import { act, cleanup, render, renderHook } from "@testing-library/react"

import { SearchableSetting } from "../SearchableSetting"
import type { SectionName } from "../SettingsView"
import { SearchIndexProvider, useSearchIndexRegistry, useSettingsSearch } from "../useSettingsSearch"

const getSectionLabel = (section: SectionName): string => section
const setting = { settingId: "ui-setting", section: "ui" as const, label: "UI setting" }

let nextFrameId = 0
let frameCallbacks = new Map<number, FrameRequestCallback>()

function flushFrame() {
	const callbacks = [...frameCallbacks.values()]
	frameCallbacks.clear()
	act(() => callbacks.forEach((callback) => callback(performance.now())))
}

describe("useSearchIndexRegistry", () => {
	beforeEach(() => {
		nextFrameId = 0
		frameCallbacks = new Map()
		vi.stubGlobal(
			"requestAnimationFrame",
			vi.fn((callback: FrameRequestCallback) => {
				const id = nextFrameId++
				frameCallbacks.set(id, callback)
				return id
			}),
		)
		vi.stubGlobal(
			"cancelAnimationFrame",
			vi.fn((id: number) => frameCallbacks.delete(id)),
		)
	})

	afterEach(() => {
		cleanup()
		vi.unstubAllGlobals()
	})

	it("batches registrations and retains its index across repeated identical tab registrations", () => {
		const { result } = renderHook(() => useSearchIndexRegistry(getSectionLabel))
		const settings = Array.from({ length: 100 }, (_, index) => ({
			...setting,
			settingId: `setting-${index}`,
			label: `Setting ${index}`,
		}))
		act(() => settings.forEach((item) => result.current.contextValue.registerSetting(item)))
		expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
		expect(result.current.index).toEqual([])
		flushFrame()
		const published = result.current.index
		expect(published).toHaveLength(100)

		for (let visit = 0; visit < 20; visit++) {
			act(() => settings.forEach((item) => result.current.contextValue.registerSetting({ ...item })))
			flushFrame()
			expect(result.current.index).toBe(published)
		}
		expect(requestAnimationFrame).toHaveBeenCalledTimes(1)
	})

	it("publishes changed labels and sections once with the latest registration", () => {
		const { result } = renderHook(() => useSearchIndexRegistry(getSectionLabel))
		act(() => result.current.contextValue.registerSetting(setting))
		flushFrame()
		const published = result.current.index

		act(() => {
			result.current.contextValue.registerSetting({ ...setting, label: "Intermediate label" })
			result.current.contextValue.registerSetting({ ...setting, section: "terminal", label: "Updated label" })
		})
		expect(frameCallbacks.size).toBe(1)
		flushFrame()
		expect(result.current.index).not.toBe(published)
		expect(result.current.index).toEqual([
			{ ...setting, section: "terminal", label: "Updated label", sectionLabel: "terminal" },
		])
	})

	it("retains its index when a registration batch restores the original values", () => {
		const { result } = renderHook(() => useSearchIndexRegistry(getSectionLabel))
		act(() => result.current.contextValue.registerSetting(setting))
		flushFrame()
		const published = result.current.index
		act(() => {
			result.current.contextValue.registerSetting({ ...setting, label: "Temporary label" })
			result.current.contextValue.registerSetting(setting)
		})
		flushFrame()
		expect(result.current.index).toBe(published)
	})

	it("refreshes existing section labels using the latest callback while cancelling its stale frame", () => {
		const { result, rerender } = renderHook(({ label }) => useSearchIndexRegistry(label), {
			initialProps: { label: getSectionLabel },
		})
		act(() => result.current.contextValue.registerSetting(setting))
		const staleFrame = [...frameCallbacks.keys()][0]
		rerender({ label: (section: SectionName) => `Updated ${section}` })
		expect(cancelAnimationFrame).toHaveBeenCalledWith(staleFrame)
		expect(frameCallbacks.size).toBe(1)
		flushFrame()
		expect(result.current.index).toEqual([{ ...setting, sectionLabel: "Updated ui" }])

		rerender({ label: (section: SectionName) => `Translated ${section}` })
		flushFrame()
		expect(result.current.index[0].sectionLabel).toBe("Translated ui")
	})

	it("does not republish labels when an equivalent callback changes identity", () => {
		const { result, rerender } = renderHook(({ label }) => useSearchIndexRegistry(label), {
			initialProps: { label: getSectionLabel },
		})
		act(() => result.current.contextValue.registerSetting(setting))
		flushFrame()
		const published = result.current.index
		for (let refresh = 0; refresh < 20; refresh++) {
			rerender({ label: (section: SectionName) => section })
			flushFrame()
			expect(result.current.index).toBe(published)
			expect(frameCallbacks.size).toBe(0)
		}
	})

	it("settles when its caller recreates an equivalent section-label callback during every render", () => {
		const { result } = renderHook(() => useSearchIndexRegistry((section) => section))
		act(() => result.current.contextValue.registerSetting(setting))
		flushFrame()
		const published = result.current.index
		flushFrame()
		expect(result.current.index).toBe(published)
		expect(frameCallbacks.size).toBe(0)
	})

	it("cancels a pending frame when its owner unmounts", () => {
		const { result, unmount } = renderHook(() => useSearchIndexRegistry(getSectionLabel))
		act(() => result.current.contextValue.registerSetting(setting))
		const frameId = [...frameCallbacks.keys()][0]
		unmount()
		expect(cancelAnimationFrame).toHaveBeenCalledWith(frameId)
		expect(frameCallbacks.size).toBe(0)
	})

	it("publishes mounted controls after StrictMode replays effects and retains unmounted tab entries", () => {
		let index: ReturnType<typeof useSearchIndexRegistry>["index"] = []
		function Harness({ visible }: { visible: boolean }) {
			const registry = useSearchIndexRegistry(getSectionLabel)
			index = registry.index
			return (
				<SearchIndexProvider value={registry.contextValue}>
					{visible && <SearchableSetting {...setting}>Setting control</SearchableSetting>}
				</SearchIndexProvider>
			)
		}
		const { rerender } = render(
			<React.StrictMode>
				<Harness visible />
			</React.StrictMode>,
		)
		flushFrame()
		expect(index).toEqual([{ ...setting, sectionLabel: "ui" }])
		const published = index
		rerender(
			<React.StrictMode>
				<Harness visible={false} />
			</React.StrictMode>,
		)
		flushFrame()
		expect(index).toBe(published)
	})

	it("keeps searches current after a meaningful registration update", () => {
		const { result } = renderHook(() => {
			const registry = useSearchIndexRegistry(getSectionLabel)
			return { ...registry, search: useSettingsSearch({ index: registry.index }) }
		})
		act(() => result.current.contextValue.registerSetting(setting))
		flushFrame()
		act(() => result.current.search.setSearchQuery("Updated"))
		expect(result.current.search.results).toEqual([])
		act(() => result.current.contextValue.registerSetting({ ...setting, label: "Updated setting" }))
		flushFrame()
		expect(result.current.search.results).toEqual([
			expect.objectContaining({ settingId: setting.settingId, label: "Updated setting" }),
		])
	})
})
