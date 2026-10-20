import { useState, useEffect, useLayoutEffect, useRef, useCallback, FormEvent } from "react"
import { VSCodeTextArea, VSCodeCheckbox } from "@vscode/webview-ui-toolkit/react"

import { supportPrompt, SupportPromptType } from "@alpha/support-prompt"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { useExtensionState } from "@src/context/ExtensionStateContext"
import {
	Button,
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
	StandardTooltip,
} from "@src/components/ui"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

interface PromptsSettingsProps {
	customSupportPrompts: Record<string, string | undefined>
	setCustomSupportPrompts: (prompts: Record<string, string | undefined>) => void
	includeTaskHistoryInEnhance: boolean
	setIncludeTaskHistoryInEnhance: (value: boolean) => void
	enhancementApiConfigId?: string
	setEnhancementApiConfigId: (value: string) => void
}

const PromptsSettings = ({
	customSupportPrompts,
	setCustomSupportPrompts,
	includeTaskHistoryInEnhance,
	setIncludeTaskHistoryInEnhance,
	enhancementApiConfigId,
	setEnhancementApiConfigId,
}: PromptsSettingsProps) => {
	const { t } = useAppTranslation()
	const { listApiConfigMeta, currentTaskId } = useExtensionState()

	const [testPrompt, setTestPrompt] = useState("")
	const [isEnhancing, setIsEnhancing] = useState(false)
	const [activeSupportOption, setActiveSupportOption] = useState<SupportPromptType>("ENHANCE")
	const enhancementConfigId = enhancementApiConfigId ?? ""
	const enhancementSupportPrompt = supportPrompt.get(customSupportPrompts, "ENHANCE")
	const pendingEnhancementRef = useRef<{
		requestId: string
		draft: string
		taskId?: string
		apiConfigId: string
		includeTaskHistory: boolean
		supportPrompt: string
	} | null>(null)
	const cancelPendingEnhancement = useCallback((updateUi = true) => {
		const pending = pendingEnhancementRef.current
		if (!pending) return
		pendingEnhancementRef.current = null
		if (updateUi) setIsEnhancing(false)
		vscode.postMessage({
			type: "cancelEnhancePrompt",
			requestId: pending.requestId,
			...(pending.taskId ? { taskId: pending.taskId } : {}),
		})
	}, [])

	useLayoutEffect(() => {
		const pending = pendingEnhancementRef.current
		if (
			pending &&
			(pending.draft !== testPrompt ||
				pending.taskId !== currentTaskId ||
				pending.apiConfigId !== enhancementConfigId ||
				pending.includeTaskHistory !== includeTaskHistoryInEnhance ||
				pending.supportPrompt !== enhancementSupportPrompt ||
				activeSupportOption !== "ENHANCE")
		) {
			cancelPendingEnhancement()
		}
	}, [
		testPrompt,
		currentTaskId,
		enhancementConfigId,
		includeTaskHistoryInEnhance,
		enhancementSupportPrompt,
		activeSupportOption,
		cancelPendingEnhancement,
	])

	useEffect(() => () => cancelPendingEnhancement(false), [cancelPendingEnhancement])

	useEffect(() => {
		const handler = (event: MessageEvent) => {
			const message = event.data
			if (message.type === "enhancedPrompt") {
				const pending = pendingEnhancementRef.current
				if (!pending || message.requestId !== pending.requestId) return
				pendingEnhancementRef.current = null
				setIsEnhancing(false)
				if (message.enhancementStatus !== undefined && message.enhancementStatus !== "success") return
				if (typeof message.text === "string" && message.text) {
					setTestPrompt(message.text)
				}
			}
		}

		window.addEventListener("message", handler)
		return () => window.removeEventListener("message", handler)
	}, [])

	const updateSupportPrompt = (type: SupportPromptType, value: string | undefined) => {
		if (type === "ENHANCE") cancelPendingEnhancement()
		// Don't trim during editing to preserve intentional whitespace
		// Use nullish coalescing to preserve empty strings
		const finalValue = value ?? undefined

		const updatedPrompts = { ...customSupportPrompts }
		if (finalValue === undefined) {
			delete updatedPrompts[type]
		} else {
			updatedPrompts[type] = finalValue
		}
		setCustomSupportPrompts(updatedPrompts)
	}

	const handleSupportReset = (type: SupportPromptType) => {
		if (type === "ENHANCE") cancelPendingEnhancement()
		const updatedPrompts = { ...customSupportPrompts }
		delete updatedPrompts[type]
		setCustomSupportPrompts(updatedPrompts)
	}

	const getSupportPromptValue = (type: SupportPromptType): string => {
		return supportPrompt.get(customSupportPrompts, type)
	}

	const handleTestEnhancement = () => {
		if (!testPrompt.trim() || pendingEnhancementRef.current) return

		const requestId = crypto.randomUUID()
		pendingEnhancementRef.current = {
			requestId,
			draft: testPrompt,
			taskId: currentTaskId,
			apiConfigId: enhancementConfigId,
			includeTaskHistory: includeTaskHistoryInEnhance,
			supportPrompt: enhancementSupportPrompt,
		}
		setIsEnhancing(true)
		vscode.postMessage({
			type: "enhancePrompt",
			requestId,
			...(currentTaskId ? { taskId: currentTaskId } : {}),
			text: testPrompt,
			enhancementOptions: {
				apiConfigId: enhancementConfigId,
				includeTaskHistory: includeTaskHistoryInEnhance,
				supportPrompt: enhancementSupportPrompt,
			},
		})
	}

	return (
		<div>
			<SectionHeader description={t("settings:prompts.description")}>
				{t("settings:sections.prompts")}
			</SectionHeader>

			<Section>
				<SearchableSetting
					settingId="prompts-support-prompt-select"
					section="prompts"
					label={t("settings:sections.prompts")}>
					<Select
						value={activeSupportOption}
						onValueChange={(type) => {
							cancelPendingEnhancement()
							setActiveSupportOption(type as SupportPromptType)
						}}>
						<SelectTrigger className="w-full" data-testid="support-prompt-select-trigger">
							<SelectValue placeholder={t("settings:common.select")} />
						</SelectTrigger>
						<SelectContent>
							{Object.keys(supportPrompt.default)
								.filter((type) => type !== "CONDENSE")
								.map((type) => (
									<SelectItem key={type} value={type} data-testid={`${type}-option`}>
										{t(`prompts:supportPrompts.types.${type}.label`)}
									</SelectItem>
								))}
						</SelectContent>
					</Select>
					<div className="text-sm text-vscode-descriptionForeground mt-1">
						{t(`prompts:supportPrompts.types.${activeSupportOption}.description`)}
					</div>
				</SearchableSetting>

				<div key={activeSupportOption} className="mt-4">
					<div className="flex justify-between items-center mb-1">
						<label className="block font-medium">{t("prompts:supportPrompts.prompt")}</label>
						<StandardTooltip
							content={t("prompts:supportPrompts.resetPrompt", {
								promptType: activeSupportOption,
							})}>
							<Button variant="ghost" size="icon" onClick={() => handleSupportReset(activeSupportOption)}>
								<span className="codicon codicon-discard"></span>
							</Button>
						</StandardTooltip>
					</div>

					<VSCodeTextArea
						resize="vertical"
						value={getSupportPromptValue(activeSupportOption)}
						onInput={(e) => {
							const value =
								(e as unknown as CustomEvent)?.detail?.target?.value ??
								((e as any).target as HTMLTextAreaElement).value
							updateSupportPrompt(activeSupportOption, value)
						}}
						rows={6}
						className="w-full"
					/>

					{activeSupportOption === "ENHANCE" && (
						<div className="mt-4 flex flex-col gap-3 pl-3 border-l-2 border-vscode-button-background">
							<div>
								<label className="block font-medium mb-1">
									{t("prompts:supportPrompts.enhance.apiConfiguration")}
								</label>
								<Select
									value={enhancementApiConfigId || "-"}
									onValueChange={(value) => {
										cancelPendingEnhancement()
										const newConfigId = value === "-" ? "" : value
										setEnhancementApiConfigId(newConfigId)
									}}>
									<SelectTrigger data-testid="api-config-select" className="w-full">
										<SelectValue
											placeholder={t("prompts:supportPrompts.enhance.useCurrentConfig")}
										/>
									</SelectTrigger>
									<SelectContent>
										<SelectItem value="-">
											{t("prompts:supportPrompts.enhance.useCurrentConfig")}
										</SelectItem>
										{(listApiConfigMeta || []).map((config) => (
											<SelectItem
												key={config.id}
												value={config.id}
												data-testid={`${config.id}-option`}>
												{config.name}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								<div className="text-sm text-vscode-descriptionForeground mt-1">
									{t("prompts:supportPrompts.enhance.apiConfigDescription")}
								</div>
							</div>

							<div>
								<VSCodeCheckbox
									checked={includeTaskHistoryInEnhance}
									onChange={(e: Event | FormEvent<HTMLElement>) => {
										const target = ("target" in e ? e.target : null) as HTMLInputElement | null

										if (!target) {
											return
										}

										cancelPendingEnhancement()
										setIncludeTaskHistoryInEnhance(target.checked)
									}}>
									<span className="font-medium">
										{t("prompts:supportPrompts.enhance.includeTaskHistory")}
									</span>
								</VSCodeCheckbox>
								<div className="text-vscode-descriptionForeground text-sm mt-1 mb-3">
									{t("prompts:supportPrompts.enhance.includeTaskHistoryDescription")}
								</div>
							</div>

							<div>
								<label className="block font-medium mb-1">
									{t("prompts:supportPrompts.enhance.testEnhancement")}
								</label>
								<VSCodeTextArea
									resize="vertical"
									value={testPrompt}
									onChange={(e) => {
										cancelPendingEnhancement()
										setTestPrompt((e.target as HTMLTextAreaElement).value)
									}}
									onKeyDown={(event) => {
										if (
											event.key === "Escape" &&
											!event.nativeEvent?.isComposing &&
											pendingEnhancementRef.current
										) {
											event.preventDefault()
											cancelPendingEnhancement()
										}
									}}
									placeholder={t("prompts:supportPrompts.enhance.testPromptPlaceholder")}
									rows={3}
									className="w-full"
									data-testid="test-prompt-textarea"
								/>
								<div className="mt-2 flex flex-wrap justify-start items-center gap-2">
									<Button
										variant="primary"
										onClick={handleTestEnhancement}
										disabled={isEnhancing}
										aria-busy={isEnhancing}>
										{t("prompts:supportPrompts.enhance.previewButton")}
									</Button>
									{isEnhancing && (
										<Button variant="secondary" onClick={() => cancelPendingEnhancement()}>
											{t("prompts:supportPrompts.enhance.cancelButton")}
										</Button>
									)}
								</div>
							</div>
						</div>
					)}
				</div>
			</Section>
		</div>
	)
}

export default PromptsSettings
