import { HTMLAttributes, useEffect } from "react"

import { cn } from "@/lib/utils"

import { normalizeSettingsSection, type SettingsSectionId } from "./settingsNavigation"
import { useSearchIndexContext } from "./useSettingsSearch"

interface SearchableSettingProps extends HTMLAttributes<HTMLDivElement> {
	/**
	 * Unique identifier for this setting.
	 * Used for finding the element after expanding its settings group.
	 */
	settingId: string
	/**
	 * The settings group this setting belongs to.
	 * Used for navigation when the setting is selected from search results.
	 */
	section: SettingsSectionId
	/**
	 * The label text for this setting, used for search matching.
	 * This should be the translated label text.
	 */
	label: string
	children: React.ReactNode
}

/**
 * Wrapper component that marks a setting as searchable.
 *
 * The component registers itself with the search index context on mount,
 * allowing the search system to index settings as they are rendered.
 *
 * @example
 * ```tsx
 * <SearchableSetting
 *   settingId="notifications-sound"
 *   section="preferences"
 *   label={t("settings:notifications.sound.label")}
 * >
 *   <VSCodeCheckbox>
 *     <span className="font-medium">{t("settings:notifications.sound.label")}</span>
 *   </VSCodeCheckbox>
 *   <div className="text-vscode-descriptionForeground text-sm">
 *     {t("settings:notifications.sound.description")}
 *   </div>
 * </SearchableSetting>
 * ```
 */
export function SearchableSetting({
	settingId,
	section,
	label,
	children,
	className,
	...props
}: SearchableSettingProps) {
	const searchContext = useSearchIndexContext()

	// Register this setting with the search index on mount
	// Retain registrations when a collapsed resource group unmounts, so searching
	// for its controls can reveal the group again without triggering discovery.
	useEffect(() => {
		if (searchContext) {
			searchContext.registerSetting({ settingId, section, label })
		}
	}, [searchContext, settingId, section, label])

	return (
		<div
			data-searchable
			data-setting-id={settingId}
			data-setting-section={normalizeSettingsSection(section) ?? section}
			data-setting-label={label}
			className={cn(className)}
			{...props}>
			{children}
		</div>
	)
}
