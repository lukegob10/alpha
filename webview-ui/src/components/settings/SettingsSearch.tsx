import { useRef, useEffect, useState, useCallback, useId } from "react"
import type { LucideIcon } from "lucide-react"

import { useSettingsSearch, type SearchResult, type SearchableSettingData } from "./useSettingsSearch"
import type { SectionName } from "./SettingsView"
import { SettingsSearchInput } from "./SettingsSearchInput"
import { SettingsSearchResults } from "./SettingsSearchResults"

interface SettingsSearchProps {
	index: SearchableSettingData[]
	onNavigate: (section: SectionName, settingId: string) => void
	sections: { id: SectionName; icon: LucideIcon }[]
}

export function SettingsSearch({ index, onNavigate, sections }: SettingsSearchProps) {
	const inputRef = useRef<HTMLInputElement>(null)
	const resultsId = useId()
	const { searchQuery, setSearchQuery, results, isOpen, setIsOpen, clearSearch } = useSettingsSearch({ index })
	const [highlightedResultId, setHighlightedResultId] = useState<string | undefined>(undefined)
	const isPopupOpen = isOpen && searchQuery.trim().length > 0

	// Handle selection of a search result
	const handleSelectResult = useCallback(
		(result: SearchResult) => {
			onNavigate(result.section, result.settingId)
			clearSearch()
			setHighlightedResultId(undefined)
			// Keep focus in the input for follow-up searches.
			setIsOpen(true)
			inputRef.current?.focus()
		},
		[onNavigate, clearSearch, setIsOpen],
	)

	// Keyboard navigation inside search results
	const moveHighlight = useCallback(
		(direction: 1 | -1) => {
			if (!results.length) return
			const flatIds = results.map((r) => r.settingId)
			const currentIndex = isOpen && highlightedResultId ? flatIds.indexOf(highlightedResultId) : -1
			setIsOpen(true)
			if (currentIndex < 0) {
				setHighlightedResultId(direction === 1 ? flatIds[0] : flatIds[flatIds.length - 1])
				return
			}
			const nextIndex = (currentIndex + direction + flatIds.length) % flatIds.length
			setHighlightedResultId(flatIds[nextIndex])
		},
		[highlightedResultId, isOpen, results, setIsOpen],
	)

	const handleSearchKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLInputElement>) => {
			if (event.key === "Escape") {
				event.preventDefault()
				setIsOpen(false)
				setHighlightedResultId(undefined)
				return
			}

			if (!results.length) return

			if (event.key === "ArrowDown") {
				event.preventDefault()
				moveHighlight(1)
				return
			}

			if (event.key === "ArrowUp") {
				event.preventDefault()
				moveHighlight(-1)
				return
			}

			if (event.key === "Enter" && isOpen && highlightedResultId) {
				event.preventDefault()
				const selected = results.find((r) => r.settingId === highlightedResultId)
				if (selected) {
					handleSelectResult(selected)
				}
				return
			}
		},
		[handleSelectResult, highlightedResultId, isOpen, moveHighlight, results, setIsOpen],
	)

	// Reset highlight based on focus and available results
	useEffect(() => {
		if (!isOpen || !results.length) {
			setHighlightedResultId(undefined)
			return
		}

		setHighlightedResultId((current) =>
			current && results.some((r) => r.settingId === current) ? current : results[0]?.settingId,
		)
	}, [isOpen, results])

	// Ensure highlighted search result stays visible within dropdown
	useEffect(() => {
		if (!highlightedResultId || !isOpen) return

		const element = document.getElementById(`settings-search-result-${highlightedResultId}`)
		element?.scrollIntoView({ block: "nearest" })
	}, [highlightedResultId, isOpen])

	return (
		<div
			className="relative justify-end"
			onBlur={(event) => {
				if (!event.currentTarget.contains(event.relatedTarget)) {
					setIsOpen(false)
					setHighlightedResultId(undefined)
				}
			}}>
			<SettingsSearchInput
				value={searchQuery}
				onChange={(value) => {
					setSearchQuery(value)
					setIsOpen(true)
				}}
				onFocus={() => setIsOpen(true)}
				onKeyDown={handleSearchKeyDown}
				inputRef={inputRef}
				isOpen={isPopupOpen}
				resultsId={resultsId}
				activeResultId={highlightedResultId ? `settings-search-result-${highlightedResultId}` : undefined}
			/>
			{isPopupOpen && (
				<div className="absolute top-full left-0 w-full mt-2 border border-vscode-dropdown-border bg-vscode-dropdown-background rounded-2xl overflow-hidden shadow-xl z-50">
					<SettingsSearchResults
						id={resultsId}
						results={results}
						query={searchQuery}
						onSelectResult={handleSelectResult}
						sections={sections}
						highlightedResultId={highlightedResultId}
					/>
				</div>
			)}
		</div>
	)
}
