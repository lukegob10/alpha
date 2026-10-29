import { useState, useMemo, useCallback, useRef, useEffect, createContext, useContext } from "react"
import { Fzf } from "fzf"

import type { SectionName } from "./SettingsView"

export interface SearchableSettingData {
	settingId: string
	section: SectionName
	label: string
	sectionLabel: string
}

export interface SearchResult {
	settingId: string
	section: SectionName
	label: string
	sectionLabel: string
	/** Character positions that matched the search query (for highlighting) */
	positions: Set<number>
}

/**
 * Context for collecting searchable settings as they mount.
 * This allows building the search index without rendering all sections.
 */
interface SearchIndexContextValue {
	registerSetting: (setting: Omit<SearchableSettingData, "sectionLabel">) => void
}

const SearchIndexContext = createContext<SearchIndexContextValue | null>(null)

export const SearchIndexProvider = SearchIndexContext.Provider

export function useSearchIndexContext() {
	return useContext(SearchIndexContext)
}

/**
 * Hook to create a search index registry.
 * Returns the context value and the current index.
 */
export function useSearchIndexRegistry(getSectionLabel: (section: SectionName) => string) {
	const settingsRef = useRef<Map<string, Omit<SearchableSettingData, "sectionLabel">>>(new Map())
	const [index, setIndex] = useState<SearchableSettingData[]>([])
	const updateFrame = useRef<number>()

	const scheduleUpdate = useCallback(() => {
		if (updateFrame.current !== undefined) return

		// Batch updates to avoid frequent re-renders
		updateFrame.current = requestAnimationFrame(() => {
			updateFrame.current = undefined
			const settings = Array.from(settingsRef.current.values()).map((s) => ({
				...s,
				sectionLabel: getSectionLabel(s.section),
			}))
			setIndex((previous) =>
				previous.length === settings.length &&
				previous.every(
					(setting, index) =>
						setting.settingId === settings[index].settingId &&
						setting.section === settings[index].section &&
						setting.label === settings[index].label &&
						setting.sectionLabel === settings[index].sectionLabel,
				)
					? previous
					: settings,
			)
		})
	}, [getSectionLabel])

	useEffect(() => {
		// Refresh translated section labels without republishing an unchanged index.
		if (settingsRef.current.size > 0) scheduleUpdate()
		return () => {
			if (updateFrame.current !== undefined) cancelAnimationFrame(updateFrame.current)
			updateFrame.current = undefined
		}
	}, [scheduleUpdate])

	const contextValue = useMemo<SearchIndexContextValue>(
		() => ({
			registerSetting: (setting) => {
				const previous = settingsRef.current.get(setting.settingId)
				// Tabs remount after indexing; identical registrations must retain the index and fuzzy matcher.
				if (previous?.section === setting.section && previous.label === setting.label) return
				settingsRef.current.set(setting.settingId, { ...setting })
				scheduleUpdate()
			},
		}),
		[scheduleUpdate],
	)

	return { contextValue, index }
}

interface UseSettingsSearchOptions {
	index: SearchableSettingData[]
}

/**
 * Hook for searching settings using fuzzy matching.
 */
export function useSettingsSearch({ index }: UseSettingsSearchOptions) {
	const [searchQuery, setSearchQuery] = useState("")
	const [isOpen, setIsOpen] = useState(false)

	// Create Fzf instance for fuzzy searching
	const fzf = useMemo(
		() =>
			new Fzf(index, {
				selector: (item) => `${item.label} ${item.sectionLabel}`,
			}),
		[index],
	)

	// Search results
	const results = useMemo((): SearchResult[] => {
		if (!searchQuery.trim()) {
			return []
		}

		const fzfResults = fzf.find(searchQuery)
		const sections = new Map<SectionName, SearchResult[]>()
		for (const result of fzfResults.slice(0, 10)) {
			const setting = { ...result.item, positions: result.positions }
			const group = sections.get(setting.section)
			if (group) group.push(setting)
			else sections.set(setting.section, [setting])
		}
		// Keyboard navigation must follow the same section grouping as the visible popup.
		return Array.from(sections.values()).flat()
	}, [fzf, searchQuery])

	const clearSearch = useCallback(() => {
		setSearchQuery("")
		setIsOpen(false)
	}, [])

	return {
		searchQuery,
		setSearchQuery,
		results,
		isOpen,
		setIsOpen,
		clearSearch,
	}
}
