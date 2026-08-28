import React from "react"
import { Check } from "lucide-react"

import { type ModeConfig, type CustomModePrompts, TelemetryEventName } from "@alpha-code/types"

import { type Mode, getAllModes, defaultModeSlug } from "@alpha/modes"

import { vscode } from "@/utils/vscode"
import { telemetryClient } from "@/utils/TelemetryClient"
import { getUserFacingModeOptions } from "@/utils/modePresentation"
import { cn } from "@/lib/utils"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { useAlphaPortal } from "@/components/ui/hooks/useAlphaPortal"
import { Popover, PopoverContent, PopoverTrigger, StandardTooltip } from "@/components/ui"

import { IconButton } from "./IconButton"

interface ModeSelectorProps {
	value: Mode
	onChange: (value: Mode) => void
	disabled?: boolean
	title: string
	triggerClassName?: string
	modeShortcutText: string
	customModes?: ModeConfig[]
	customModePrompts?: CustomModePrompts
}

export const ModeSelector = ({
	value,
	onChange,
	disabled = false,
	title,
	triggerClassName = "",
	modeShortcutText,
	customModes,
	customModePrompts,
}: ModeSelectorProps) => {
	const [open, setOpen] = React.useState(false)
	const selectedItemRef = React.useRef<HTMLDivElement>(null)
	const scrollContainerRef = React.useRef<HTMLDivElement>(null)
	const lastNotifiedInvalidModeRef = React.useRef<string | null>(null)
	const portalContainer = useAlphaPortal("alpha-portal")
	const { hasOpenedModeSelector, setHasOpenedModeSelector } = useExtensionState()
	const { t } = useAppTranslation()

	const trackModeSelectorOpened = React.useCallback(() => {
		// Track telemetry every time the mode selector is opened.
		telemetryClient.capture(TelemetryEventName.MODE_SELECTOR_OPENED)

		// Track first-time usage for UI purposes.
		if (!hasOpenedModeSelector) {
			setHasOpenedModeSelector(true)
			vscode.postMessage({ type: "hasOpenedModeSelector", bool: true })
		}
	}, [hasOpenedModeSelector, setHasOpenedModeSelector])

	// Get all modes including custom modes and merge custom prompt descriptions.
	const modes = React.useMemo(() => {
		const allModes = getUserFacingModeOptions(getAllModes(customModes), value)

		return allModes.map((mode) => ({
			...mode,
			description: customModePrompts?.[mode.slug]?.description ?? mode.description,
		}))
	}, [customModes, customModePrompts, value])

	// Find the selected mode, falling back to default if current mode doesn't exist (e.g., after workspace switch)
	const selectedMode = React.useMemo(() => {
		return modes.find((mode) => mode.slug === value) ?? modes.find((mode) => mode.slug === defaultModeSlug)
	}, [modes, value])

	// Notify parent when current mode is invalid so it can update its state
	React.useEffect(() => {
		const isValidMode = modes.some((mode) => mode.slug === value)

		if (isValidMode) {
			lastNotifiedInvalidModeRef.current = null
			return
		}

		if (lastNotifiedInvalidModeRef.current === value) {
			return
		}

		const fallbackMode = modes.find((mode) => mode.slug === defaultModeSlug)
		if (fallbackMode) {
			lastNotifiedInvalidModeRef.current = value
			onChange(fallbackMode.slug as Mode)
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps -- onChange omitted to prevent loops when parent doesn't memoize
	}, [modes, value])

	const handleSelect = React.useCallback(
		(modeSlug: string) => {
			if (disabled) return

			onChange(modeSlug as Mode)
			setOpen(false)
		},
		[disabled, onChange],
	)

	const onOpenChange = React.useCallback(
		(isOpen: boolean) => {
			if (disabled && isOpen) return

			if (isOpen) trackModeSelectorOpened()
			setOpen(isOpen)
		},
		[disabled, trackModeSelectorOpened],
	)

	React.useEffect(() => {
		if (disabled) setOpen(false)
	}, [disabled])

	// Scroll to the selected compatibility item when an older task is restored.
	React.useEffect(() => {
		if (open) {
			requestAnimationFrame(() => {
				if (selectedItemRef.current && scrollContainerRef.current) {
					const container = scrollContainerRef.current
					const item = selectedItemRef.current

					// Calculate positions
					const containerHeight = container.clientHeight
					const itemTop = item.offsetTop
					const itemHeight = item.offsetHeight

					// Center the item in the container
					const scrollPosition = itemTop - containerHeight / 2 + itemHeight / 2

					// Ensure we don't scroll past boundaries
					const maxScroll = container.scrollHeight - containerHeight
					const finalScrollPosition = Math.min(Math.max(0, scrollPosition), maxScroll)

					container.scrollTo({
						top: finalScrollPosition,
						behavior: "instant",
					})
				}
			})
		}
	}, [open])

	// Combine instruction text for tooltip.
	const instructionText = `${t("chat:modeSelector.description")} ${modeShortcutText}`

	return (
		<Popover open={open} onOpenChange={onOpenChange} data-testid="mode-selector-root">
			<StandardTooltip content={title}>
				<PopoverTrigger
					disabled={disabled}
					data-testid="mode-selector-trigger"
					className={cn(
						"inline-flex items-center relative whitespace-nowrap px-1.5 py-1 text-xs",
						"composer-control text-vscode-foreground",
						"transition-all duration-150 focus:outline-none focus-visible:ring-1 focus-visible:ring-vscode-focusBorder focus-visible:ring-inset",
						disabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer opacity-90 hover:opacity-100",
						triggerClassName,
						!disabled && !hasOpenedModeSelector ? "accent-chip opacity-100" : null,
					)}>
					<span className="truncate">{selectedMode?.name || ""}</span>
				</PopoverTrigger>
			</StandardTooltip>
			<PopoverContent
				align="start"
				sideOffset={4}
				container={portalContainer}
				className="p-0 overflow-hidden min-w-80 max-w-9/10">
				<div className="flex flex-col w-full">
					<div className="p-3 border-b border-vscode-dropdown-border">
						<p className="m-0 text-xs text-vscode-descriptionForeground">{instructionText}</p>
					</div>

					{/* Mode List */}
					<div ref={scrollContainerRef} className="max-h-[300px] overflow-y-auto">
						<div className="py-1">
							{modes.map((mode) => {
								const isSelected = mode.slug === value
								return (
									<div
										key={mode.slug}
										ref={isSelected ? selectedItemRef : null}
										onClick={() => handleSelect(mode.slug)}
										className={cn(
											"px-3 py-1.5 text-sm cursor-pointer flex items-center",
											"hover:bg-vscode-list-hoverBackground",
											isSelected ? "bg-[var(--alpha-accent-soft)] text-vscode-foreground" : "",
										)}
										data-testid="mode-selector-item">
										<div className="flex-1 min-w-0">
											<div className="font-bold truncate">{mode.name}</div>
											{mode.description && (
												<div className="text-xs text-vscode-descriptionForeground truncate">
													{mode.description}
												</div>
											)}
										</div>
										{isSelected && <Check className="ml-auto size-4 p-0.5" />}
									</div>
								)
							})}
						</div>
					</div>

					{/* Bottom bar with settings on the left and title on the right */}
					<div className="flex flex-row items-center justify-between px-2 py-2 border-t border-vscode-dropdown-border">
						<div>
							<IconButton
								iconClass="codicon-settings-gear"
								title={t("chat:modeSelector.settings")}
								onClick={() => {
									vscode.postMessage({
										type: "switchTab",
										tab: "settings",
										values: { section: "modes" },
									})
									setOpen(false)
								}}
							/>
						</div>

						<div className="flex items-center gap-1 pr-1">
							<h4 className="m-0 font-medium text-sm text-vscode-descriptionForeground">
								{t("chat:modeSelector.title")}
							</h4>
						</div>
					</div>
				</div>
			</PopoverContent>
		</Popover>
	)
}
