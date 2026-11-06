import { useState, useMemo, useCallback, useEffect } from "react"
import { Fzf } from "fzf"
import type { ProviderSettingsEntry } from "@alpha-code/types"

import { cn } from "@/lib/utils"
import { useAlphaPortal } from "@/components/ui/hooks/useAlphaPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import { Button } from "@/components/ui"

import { IconButton } from "./IconButton"

interface ApiConfigSelectorProps {
	value: string
	displayName: string
	disabled?: boolean
	isVisible?: boolean
	title: string
	onChange: (value: string) => void
	triggerClassName?: string
	listApiConfigMeta: ProviderSettingsEntry[]
	pinnedApiConfigs?: Record<string, boolean>
	togglePinnedApiConfig: (id: string) => void
}

export const ApiConfigSelector = ({
	value,
	displayName,
	disabled = false,
	isVisible = true,
	title,
	onChange,
	triggerClassName = "",
	listApiConfigMeta,
	pinnedApiConfigs,
	togglePinnedApiConfig,
}: ApiConfigSelectorProps) => {
	const { t } = useAppTranslation()
	const [open, setOpen] = useState(false)
	const [searchValue, setSearchValue] = useState("")
	const portalContainer = useAlphaPortal("alpha-portal")
	useEffect(() => {
		if (!isVisible) setOpen(false)
	}, [isVisible])
	const onOpenChange = useCallback((isOpen: boolean) => setOpen(isOpen && isVisible), [isVisible])

	// Create searchable items for fuzzy search.
	const searchableItems = useMemo(
		() =>
			listApiConfigMeta.map((config) => ({
				original: config,
				searchStr: config.name,
			})),
		[listApiConfigMeta],
	)

	// Create Fzf instance.
	const fzfInstance = useMemo(
		() => new Fzf(searchableItems, { selector: (item) => item.searchStr }),
		[searchableItems],
	)

	// Filter configs based on search.
	const filteredConfigs = useMemo(() => {
		if (!searchValue) {
			return listApiConfigMeta
		}

		const matchingItems = fzfInstance.find(searchValue).map((result) => result.item.original)
		return matchingItems
	}, [listApiConfigMeta, searchValue, fzfInstance])

	// Separate pinned and unpinned configs.
	const { pinnedConfigs, unpinnedConfigs } = useMemo(() => {
		const pinned = filteredConfigs.filter((config) => pinnedApiConfigs?.[config.id])
		const unpinned = filteredConfigs.filter((config) => !pinnedApiConfigs?.[config.id])
		return { pinnedConfigs: pinned, unpinnedConfigs: unpinned }
	}, [filteredConfigs, pinnedApiConfigs])

	const handleSelect = useCallback(
		(configId: string) => {
			if (!isVisible || listApiConfigMeta.find(({ id }) => id === configId)?.availability) return
			onChange(configId)
			setOpen(false)
			setSearchValue("")
		},
		[isVisible, onChange, listApiConfigMeta],
	)

	const handleEditClick = useCallback(() => {
		vscode.postMessage({ type: "switchTab", tab: "settings" })
		setOpen(false)
	}, [])

	const renderConfigItem = useCallback(
		(config: ProviderSettingsEntry, isPinned: boolean) => {
			const isCurrentConfig = config.id === value
			const unavailableLabel = config.availability
				? t(
						config.availability === "invalid"
							? "settings:providers.profileUnavailableInvalid"
							: "settings:providers.profileUnavailableUnsupported",
					)
				: undefined

			return (
				<div
					key={config.id}
					className={cn(
						"composer-menu-profile-row group",
						"hover:bg-[var(--alpha-accent-soft)]",
						isCurrentConfig && "bg-[var(--alpha-accent-soft)] text-vscode-foreground",
					)}>
					<button
						type="button"
						disabled={Boolean(config.availability)}
						title={unavailableLabel}
						onClick={() => handleSelect(config.id)}
						aria-current={isCurrentConfig ? "true" : undefined}
						className="composer-menu-item composer-menu-profile-item">
						<span className="flex-1 min-w-0 flex items-center gap-1 overflow-hidden">
							<span className="flex-shrink-0">{config.name}</span>
							{unavailableLabel && <span className="text-xs">{unavailableLabel}</span>}
							{config.modelId && (
								<span
									className="text-vscode-descriptionForeground opacity-70 min-w-0 overflow-hidden"
									style={{ direction: "rtl", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
									{config.modelId}
								</span>
							)}
						</span>
						{isCurrentConfig && (
							<span className="composer-menu-check codicon codicon-check" aria-hidden="true" />
						)}
					</button>
					<div className="flex items-center gap-1">
						<StandardTooltip className="lowercase" content={isPinned ? t("chat:unpin") : t("chat:pin")}>
							<Button
								variant="ghost"
								size="icon"
								aria-label={isPinned ? t("chat:unpin") : t("chat:pin")}
								onClick={() => {
									togglePinnedApiConfig(config.id)
									vscode.postMessage({ type: "toggleApiConfigPin", text: config.id })
								}}
								className={cn("size-5 flex items-center justify-center", {
									"opacity-0 group-hover:opacity-100 focus-visible:opacity-100":
										!isPinned && !isCurrentConfig,
									"bg-accent opacity-100": isPinned,
								})}>
								<span className="codicon codicon-pin text-xs opacity-50" />
							</Button>
						</StandardTooltip>
					</div>
				</div>
			)
		},
		[value, handleSelect, t, togglePinnedApiConfig],
	)

	return (
		<Popover open={open && isVisible} onOpenChange={onOpenChange} data-testid="api-config-selector-root">
			<StandardTooltip className="lowercase" content={displayName ? `${title}: ${displayName}` : title}>
				<PopoverTrigger
					disabled={disabled}
					data-testid="dropdown-trigger"
					className={cn("composer-control composer-selector composer-menu-trigger", triggerClassName)}>
					<span className="truncate">{displayName}</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				aria-label={title}
				align="start"
				sideOffset={4}
				container={portalContainer}
				onCloseAutoFocus={(event) => {
					if (!isVisible) event.preventDefault()
				}}
				className="composer-menu p-0 overflow-hidden w-[min(180px,calc(100vw-24px))]">
				<div className="flex flex-col w-full">
					{listApiConfigMeta.length > 6 && (
						<div className="relative p-2 border-b border-vscode-dropdown-border">
							<input
								aria-label={t("common:ui.search_placeholder")}
								value={searchValue}
								onChange={(e) => setSearchValue(e.target.value)}
								placeholder={t("common:ui.search_placeholder")}
								className="w-full h-8 px-2 py-1 text-xs bg-vscode-input-background text-vscode-input-foreground border border-vscode-input-border rounded focus:outline-0"
								autoFocus
							/>
							{searchValue.length > 0 && (
								<div className="absolute right-4 top-0 bottom-0 flex items-center justify-center">
									<button
										type="button"
										aria-label="Clear search"
										className="codicon codicon-close text-vscode-input-foreground opacity-50 hover:opacity-100 text-xs cursor-pointer"
										onClick={() => setSearchValue("")}
									/>
								</div>
							)}
						</div>
					)}

					{/* Config list - single scroll container */}
					{filteredConfigs.length === 0 && searchValue ? (
						<div className="py-2 px-3 text-sm text-vscode-foreground/70">{t("common:ui.no_results")}</div>
					) : (
						<div className="max-h-[300px] overflow-y-auto">
							{/* Pinned configs - sticky header */}
							{pinnedConfigs.length > 0 && (
								<div
									className={cn(
										"sticky top-0 z-10 bg-vscode-dropdown-background py-1",
										unpinnedConfigs.length > 0 && "border-b border-vscode-dropdown-foreground/10",
									)}
									aria-label="Pinned configurations">
									{pinnedConfigs.map((config) => renderConfigItem(config, true))}
								</div>
							)}

							{/* Unpinned configs */}
							{unpinnedConfigs.length > 0 && (
								<div className="py-1" aria-label="All configurations">
									{unpinnedConfigs.map((config) => renderConfigItem(config, false))}
								</div>
							)}
						</div>
					)}

					<div className="composer-menu-footer">
						<IconButton
							iconClass="codicon-settings-gear"
							title={t("chat:edit")}
							onClick={handleEditClick}
							tooltip={false}
						/>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
