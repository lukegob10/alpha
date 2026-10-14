import { useEffect, useId, useState } from "react"
import { ChevronDown } from "lucide-react"
import {
	taskReasoningCustomTokenPattern,
	type ReasoningEffortExtended,
	type TaskReasoningPreference,
	type TaskReasoningProjection,
	type TaskReasoningState,
} from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { useAlphaPortal } from "@/components/ui/hooks/useAlphaPortal"
import { Button, Input, Popover, PopoverContent, PopoverTrigger, Slider } from "@/components/ui"
import { cn } from "@/lib/utils"

const reasoningEffortOrder: readonly ReasoningEffortExtended[] = [
	"none",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]

function sortReasoningEfforts(efforts: readonly ReasoningEffortExtended[]): ReasoningEffortExtended[] {
	return [...new Set(efforts)].sort(
		(left, right) => reasoningEffortOrder.indexOf(left) - reasoningEffortOrder.indexOf(right),
	)
}

function useReasoningLabel() {
	const { t } = useAppTranslation()
	return (preference: TaskReasoningPreference): string => {
		if (preference.kind === "custom") return preference.value
		if (preference.kind === "effort") {
			return preference.effort === "none"
				? t("chat:reasoning.none")
				: t(`settings:providers.reasoningEffort.${preference.effort}`)
		}
		return t(`chat:reasoning.${preference.kind}`)
	}
}

export function ReasoningSummary({ state }: { state: TaskReasoningState }) {
	const { t } = useAppTranslation()
	const label = useReasoningLabel()
	return (
		<div className="space-y-1 text-xs text-vscode-descriptionForeground">
			<div>{t("chat:reasoning.label", { value: label(state.effective) })}</div>
			{state.capabilities.kind === "budget" && state.capabilities.budgetTokens !== undefined && (
				<div>{t("chat:reasoning.budget", { tokens: state.capabilities.budgetTokens.toLocaleString() })}</div>
			)}
			{state.fallbackReason && (
				<div>
					{t("chat:reasoning.fallback", {
						requested: label(state.requested),
						effective: label(state.effective),
					})}{" "}
					{t(`chat:reasoning.reasons.${state.fallbackReason}`)}
				</div>
			)}
		</div>
	)
}

export interface ReasoningSelectorProps {
	state?: TaskReasoningProjection
	loading?: boolean
	saving?: boolean
	error?: boolean
	onChange: (preference: TaskReasoningPreference) => void
	onOpenAdvanced?: () => void
	scopeKey: string
}

/** Presentation only: callers own persistence and the acknowledged capability projection. */
export function ReasoningSelector({
	state,
	loading = false,
	saving = false,
	error = false,
	onChange,
	onOpenAdvanced,
	scopeKey,
}: ReasoningSelectorProps) {
	const { t } = useAppTranslation()
	const label = useReasoningLabel()
	const portal = useAlphaPortal("alpha-portal")
	const id = useId()
	const titleId = `${id}-title`
	const [open, setOpen] = useState(false)
	const [custom, setCustom] = useState("")
	const [invalidCustom, setInvalidCustom] = useState(false)
	const [sliderIndex, setSliderIndex] = useState(0)
	const capabilitiesKey = JSON.stringify(state?.capabilities)
	const requestedCustom = state?.requested.kind === "custom" ? state.requested.value : ""
	useEffect(() => {
		setOpen(false)
		setInvalidCustom(false)
	}, [scopeKey, capabilitiesKey, loading])
	useEffect(() => {
		setCustom(requestedCustom)
		// A streamed state refresh must not erase a custom token being edited.
	}, [scopeKey, requestedCustom])

	const ready = !loading && state !== undefined
	const capabilities = ready ? state.capabilities : undefined
	const effortValues = capabilities?.kind === "effort" ? sortReasoningEfforts(capabilities.efforts ?? []) : []
	const compactEffort = capabilities?.kind === "effort"
	const selected = state?.requested.kind === "default" ? state.requested : state?.effective
	const options: TaskReasoningPreference[] = [{ kind: "default" }]
	if (capabilities && capabilities.kind !== "unavailable") {
		if (capabilities.canDisable) options.push({ kind: "off" })
		if (capabilities.kind === "binary" || capabilities.kind === "budget") options.push({ kind: "on" })
	}
	const sliderOptions: TaskReasoningPreference[] = effortValues.map(
		(effort): TaskReasoningPreference => ({ kind: "effort", effort }),
	)
	const selectedIndex = sliderOptions.findIndex((option) => JSON.stringify(option) === JSON.stringify(selected))
	const displayEffortIndex = Math.max(0, selectedIndex)
	const displayedEffortPreference = sliderOptions[sliderIndex] ?? sliderOptions[displayEffortIndex]
	useEffect(() => {
		setSliderIndex(displayEffortIndex)
	}, [scopeKey, capabilitiesKey, displayEffortIndex, open])
	const value = !ready
		? t(error ? "chat:reasoning.unavailable" : "chat:reasoning.loading")
		: capabilities?.kind === "unavailable"
			? t("chat:reasoning.unavailable")
			: label(state.effective)
	const title = t("chat:reasoning.label", { value })
	const choose = (preference: TaskReasoningPreference) => {
		onChange(preference)
		setOpen(false)
	}
	const chooseEffort = (index: number) => {
		const preference = sliderOptions[index]
		if (!preference) return
		setSliderIndex(index)
		choose(preference)
	}
	const applyCustom = () => {
		const valid = taskReasoningCustomTokenPattern.test(custom)
		setInvalidCustom(custom.length > 0 && !valid)
		onChange(valid ? { kind: "custom", value: custom } : { kind: "off" })
		if (valid || custom.length === 0) setOpen(false)
	}

	return (
		<div className="min-w-0 max-w-full" data-testid="reasoning-control">
			<Popover open={open && ready} onOpenChange={setOpen}>
				<PopoverTrigger asChild>
					<button
						type="button"
						data-testid="reasoning-trigger"
						aria-label={title}
						aria-busy={saving || (!error && !ready)}
						disabled={!ready}
						title={title}
						className="composer-control composer-selector">
						<span className="truncate">{value}</span>
						{saving ? (
							<span className="shrink-0">· {t("chat:reasoning.saving")}</span>
						) : state?.pending ? (
							<span className="shrink-0">· {t("chat:reasoning.nextStep")}</span>
						) : null}
						<ChevronDown className="size-3 shrink-0" aria-hidden="true" />
					</button>
				</PopoverTrigger>
				<PopoverContent
					container={portal}
					align="start"
					aria-labelledby={titleId}
					className={cn(
						"max-w-[calc(100vw-24px)] space-y-3 p-3",
						compactEffort
							? "w-[min(15rem,calc(100vw-24px))] rounded-2xl space-y-2.5"
							: "w-[min(20rem,calc(100vw-24px))]",
					)}>
					<h2 id={titleId} className={cn("m-0 font-medium", compactEffort && "sr-only")}>
						{t("chat:reasoning.title")}
					</h2>
					{capabilities?.kind === "effort" && effortValues.length > 0 ? (
						<div className="space-y-2.5" data-testid="reasoning-effort-slider-panel">
							<div className="flex items-center justify-end gap-2">
								<span className="rounded-md bg-[var(--alpha-accent-soft)] px-1.5 py-0.5 text-xs font-medium">
									{label(displayedEffortPreference)}
								</span>
							</div>
							{sliderOptions.length > 1 && (
								<div className="space-y-1.5">
									<div className="relative px-1">
										<div
											aria-hidden="true"
											className="pointer-events-none absolute inset-x-2 top-1/2 z-10 flex -translate-y-1/2 items-center justify-between">
											{sliderOptions.map((option, index) => (
												<span
													key={JSON.stringify(option)}
													className={cn(
														"size-1 rounded-full transition-colors duration-150 ease-out",
														index <= sliderIndex
															? "bg-[var(--vscode-button-foreground)]/70"
															: "bg-[var(--vscode-descriptionForeground)]/60",
													)}
												/>
											))}
										</div>
										<Slider
											data-testid="reasoning-slider"
											aria-label={t("chat:reasoning.title")}
											aria-valuetext={label(displayedEffortPreference)}
											className="relative z-0 h-5 [&_[data-slot=slider-track]]:h-2.5 [&_[data-slot=slider-track]]:rounded-full [&_[data-slot=slider-track]]:border-0 [&_[data-slot=slider-range]]:bg-[var(--vscode-textLink-foreground)] [&_[data-slot=slider-range]]:transition-[left,right] [&_[data-slot=slider-range]]:duration-150 [&_[data-slot=slider-range]]:ease-out [&>span:not([data-slot=slider-track])]:transition-[left] [&>span:not([data-slot=slider-track])]:duration-150 [&>span:not([data-slot=slider-track])]:ease-out [&_[data-slot=slider-thumb]]:relative [&_[data-slot=slider-thumb]]:z-20 [&_[data-slot=slider-thumb]]:h-5 [&_[data-slot=slider-thumb]]:w-5 [&_[data-slot=slider-thumb]]:border-0 [&_[data-slot=slider-thumb]]:bg-[var(--vscode-button-foreground)] [&_[data-slot=slider-thumb]]:shadow-md [&_[data-slot=slider-thumb]]:transition-[background-color,box-shadow] [&_[data-slot=slider-thumb]]:duration-150 [&_[data-slot=slider-thumb]]:ease-out"
											value={[sliderIndex]}
											min={0}
											max={sliderOptions.length - 1}
											step={1}
											onValueChange={([index]) => {
												if (index !== undefined) setSliderIndex(index)
											}}
											onValueCommit={([index]) => {
												if (index !== undefined) chooseEffort(index)
											}}
										/>
									</div>
								</div>
							)}
						</div>
					) : (
						<div role="group" aria-label={t("chat:reasoning.title")} className="flex flex-wrap gap-1">
							{options.map((option) => (
								<button
									key={JSON.stringify(option)}
									type="button"
									data-testid={`reasoning-choice-${option.kind}`}
									aria-pressed={JSON.stringify(selected) === JSON.stringify(option)}
									onClick={() => choose(option)}
									className="rounded-md border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm text-vscode-foreground hover:border-[var(--border-accent)] hover:bg-[var(--alpha-accent-soft)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-vscode-focusBorder aria-pressed:border-[var(--border-accent)] aria-pressed:bg-[var(--alpha-accent-soft)]">
									{label(option)}
								</button>
							))}
						</div>
					)}
					{capabilities?.kind === "unavailable" ? (
						<p className="m-0 text-xs text-vscode-descriptionForeground">
							{t("chat:reasoning.unavailableHelp")}
						</p>
					) : !compactEffort ? (
						<p className="m-0 text-xs text-vscode-descriptionForeground">{t("chat:reasoning.help")}</p>
					) : null}
					{state && (!compactEffort || state.fallbackReason || state.pending) && (
						<ReasoningSummary state={state} />
					)}
					{state?.pending && state.current && (
						<div className="text-xs">
							{t("chat:reasoning.current", { value: label(state.current.effective) })}
						</div>
					)}
					{capabilities?.kind === "budget" && onOpenAdvanced && (
						<Button
							variant="secondary"
							size="sm"
							onClick={() => {
								setOpen(false)
								onOpenAdvanced()
							}}>
							{t("chat:reasoning.advanced")}
						</Button>
					)}
					{capabilities?.kind === "custom" && (
						<div className="space-y-2">
							<label htmlFor={`${id}-custom`} className="block text-xs">
								{t("chat:reasoning.custom")}
							</label>
							<Input
								id={`${id}-custom`}
								value={custom}
								maxLength={128}
								aria-describedby={`${id}-custom-help`}
								aria-invalid={invalidCustom}
								onChange={(event) => {
									setCustom(event.target.value)
									setInvalidCustom(false)
								}}
								onKeyDown={(event) => {
									if (event.key === "Enter") {
										event.preventDefault()
										applyCustom()
									}
								}}
							/>
							<p id={`${id}-custom-help`} className="m-0 text-xs text-vscode-descriptionForeground">
								{t("chat:reasoning.customHelp")}
							</p>
							{invalidCustom && (
								<div role="alert" className="text-xs text-vscode-errorForeground">
									{t("chat:reasoning.invalidCustom")}
								</div>
							)}
							<Button size="sm" onClick={applyCustom}>
								{t("chat:reasoning.apply")}
							</Button>
						</div>
					)}
				</PopoverContent>
			</Popover>
			{saving && (
				<span role="status" className="sr-only">
					{t("chat:reasoning.saving")}
				</span>
			)}
			{error && (
				<div role="alert" className="text-xs text-vscode-errorForeground">
					{t(state ? "chat:reasoning.saveFailed" : "chat:reasoning.unavailableHelp")}
				</div>
			)}
		</div>
	)
}
