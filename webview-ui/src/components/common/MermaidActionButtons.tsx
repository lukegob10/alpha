import React from "react"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { IconButton } from "./IconButton"
import { ZoomControls } from "./ZoomControls"

interface MermaidActionButtonsProps {
	onZoom?: (e: React.MouseEvent) => void
	onZoomIn?: () => void
	onZoomOut?: () => void
	onCopy: (e: React.MouseEvent) => void
	onSave?: (e: React.MouseEvent) => void
	onViewCode: () => void
	onClose?: () => void
	copyFeedback: boolean
	showZoomControls?: boolean
	zoomLevel?: number
}

export const MermaidActionButtons: React.FC<MermaidActionButtonsProps> = ({
	onZoom,
	onZoomIn,
	onZoomOut,
	onCopy,
	onSave,
	onViewCode,
	onClose,
	copyFeedback,
	showZoomControls = false,
	zoomLevel,
}) => {
	const { t } = useAppTranslation()

	if (showZoomControls && onZoomOut && onZoomIn && zoomLevel !== undefined) {
		return (
			<>
				<ZoomControls
					zoomLevel={zoomLevel}
					onZoomIn={onZoomIn}
					onZoomOut={onZoomOut}
					zoomInTitle={t("common:mermaid.buttons.zoomIn")}
					zoomOutTitle={t("common:mermaid.buttons.zoomOut")}
				/>
				<IconButton
					icon="code"
					title={t("common:mermaid.buttons.viewCode")}
					onClick={(e: React.MouseEvent) => {
						e.stopPropagation()
						onViewCode()
					}}
				/>
				<IconButton
					icon={copyFeedback ? "check" : "copy"}
					title={t("common:mermaid.buttons.copy")}
					onClick={onCopy}
				/>
			</>
		)
	}

	return (
		<>
			{onZoom && <IconButton icon="zoom-in" title={t("common:mermaid.buttons.zoom")} onClick={onZoom} />}
			<IconButton
				icon="code"
				title={t("common:mermaid.buttons.viewCode")}
				onClick={(e: React.MouseEvent) => {
					e.stopPropagation()
					onViewCode()
				}}
			/>
			<IconButton
				icon={copyFeedback ? "check" : "copy"}
				title={t("common:mermaid.buttons.copy")}
				onClick={onCopy}
			/>
			{onSave && <IconButton icon="save" title={t("common:mermaid.buttons.save")} onClick={onSave} />}
			{onClose && <IconButton icon="close" title={t("common:mermaid.buttons.close")} onClick={onClose} />}
		</>
	)
}
