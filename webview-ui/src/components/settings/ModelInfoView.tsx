import type { ModelInfo } from "@alpha-code/types"

import { formatPrice } from "@src/utils/formatPrice"
import { cn } from "@src/lib/utils"
import { useAppTranslation } from "@src/i18n/TranslationContext"

import { ModelDescriptionMarkdown } from "./ModelDescriptionMarkdown"

type ModelInfoViewProps = {
	modelInfo?: ModelInfo
	isDescriptionExpanded: boolean
	setIsDescriptionExpanded: (isExpanded: boolean) => void
	hidePricing?: boolean
}

export const ModelInfoView = ({
	modelInfo,
	isDescriptionExpanded,
	setIsDescriptionExpanded,
	hidePricing,
}: ModelInfoViewProps) => {
	const { t } = useAppTranslation()

	const baseInfoItems = [
		typeof modelInfo?.contextWindow === "number" && modelInfo.contextWindow > 0 && (
			<>
				<span className="font-medium">{t("settings:modelInfo.contextWindow")}</span>{" "}
				{modelInfo.contextWindow?.toLocaleString()} tokens
			</>
		),
		typeof modelInfo?.maxTokens === "number" && modelInfo.maxTokens > 0 && (
			<>
				<span className="font-medium">{t("settings:modelInfo.maxOutput")}:</span>{" "}
				{modelInfo.maxTokens?.toLocaleString()} tokens
			</>
		),
		<ModelInfoSupportsItem
			isSupported={modelInfo?.supportsImages ?? false}
			supportsLabel={t("settings:modelInfo.supportsImages")}
			doesNotSupportLabel={t("settings:modelInfo.noImages")}
		/>,
		<ModelInfoSupportsItem
			isSupported={modelInfo?.supportsPromptCache ?? false}
			supportsLabel={t("settings:modelInfo.supportsPromptCache")}
			doesNotSupportLabel={t("settings:modelInfo.noPromptCache")}
		/>,
	].filter(Boolean)

	const priceInfoItems = [
		modelInfo?.inputPrice !== undefined && (
			<>
				<span className="font-medium">{t("settings:modelInfo.inputPrice")}:</span>{" "}
				{formatPrice(modelInfo.inputPrice)} / 1M tokens
			</>
		),
		modelInfo?.outputPrice !== undefined && (
			<>
				<span className="font-medium">{t("settings:modelInfo.outputPrice")}:</span>{" "}
				{formatPrice(modelInfo.outputPrice)} / 1M tokens
			</>
		),
		modelInfo?.supportsPromptCache && modelInfo.cacheReadsPrice && (
			<>
				<span className="font-medium">{t("settings:modelInfo.cacheReadsPrice")}:</span>{" "}
				{formatPrice(modelInfo.cacheReadsPrice || 0)} / 1M tokens
			</>
		),
		modelInfo?.supportsPromptCache && modelInfo.cacheWritesPrice && (
			<>
				<span className="font-medium">{t("settings:modelInfo.cacheWritesPrice")}:</span>{" "}
				{formatPrice(modelInfo.cacheWritesPrice || 0)} / 1M tokens
			</>
		),
	].filter(Boolean)

	const infoItems = hidePricing ? baseInfoItems : [...baseInfoItems, ...priceInfoItems]

	return (
		<>
			{modelInfo?.description && (
				<ModelDescriptionMarkdown
					key="description"
					markdown={modelInfo.description}
					isExpanded={isDescriptionExpanded}
					setIsExpanded={setIsDescriptionExpanded}
				/>
			)}
			<div className="text-sm text-vscode-descriptionForeground">
				{infoItems.map((item, index) => (
					<div key={index}>{item}</div>
				))}
			</div>
		</>
	)
}

const ModelInfoSupportsItem = ({
	isSupported,
	supportsLabel,
	doesNotSupportLabel,
}: {
	isSupported: boolean
	supportsLabel: string
	doesNotSupportLabel: string
}) => (
	<div className="flex items-center gap-1 font-medium">
		<span className={cn("codicon", isSupported ? "codicon-check" : "codicon-x")} />
		{isSupported ? supportsLabel : doesNotSupportLabel}
	</div>
)
