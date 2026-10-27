import { useRef, useState } from "react"
import { useCopyToClipboard } from "@src/utils/clipboard"
import { useAppTranslation } from "@src/i18n/TranslationContext"
import { Button } from "@/components/ui"
import { MermaidActionButtons } from "./MermaidActionButtons"
import { Modal } from "./Modal"
import { IconButton } from "./IconButton"

export interface MermaidButtonProps {
	code: string
	isLoading: boolean
	onOpen: () => void
	onSave: () => Promise<void>
	children: React.ReactNode
}

export function MermaidButton({ code, isLoading, onOpen, onSave, children }: MermaidButtonProps) {
	const [showCode, setShowCode] = useState(false)
	const codeRef = useRef<HTMLTextAreaElement>(null)
	const { showCopyFeedback, copyWithFeedback } = useCopyToClipboard()
	const { t } = useAppTranslation()
	const handleCopy = async (event: React.MouseEvent) => {
		await copyWithFeedback(code, event)
	}

	return (
		<>
			<div className="min-w-0 max-w-full">
				<div className="mb-1 flex flex-wrap items-center justify-between gap-1">
					<Button variant="secondary" className="h-7 gap-1 px-2" disabled={isLoading} onClick={onOpen}>
						<span className="codicon codicon-link-external" aria-hidden="true" />
						{t("common:mermaid.buttons.open")}
					</Button>
					{!isLoading && (
						<div className="flex gap-1">
							<MermaidActionButtons
								onCopy={handleCopy}
								onSave={() => void onSave()}
								onViewCode={() => setShowCode(true)}
								copyFeedback={showCopyFeedback}
							/>
						</div>
					)}
				</div>
				{children}
			</div>
			<Modal
				isOpen={showCode}
				onClose={() => setShowCode(false)}
				title={t("common:mermaid.modal.codeTitle")}
				initialFocusRef={codeRef}>
				<div className="flex shrink-0 items-center justify-between border-b border-vscode-editorGroup-border p-2">
					<span>{t("common:mermaid.modal.codeTitle")}</span>
					<IconButton
						icon="close"
						title={t("common:mermaid.buttons.close")}
						onClick={() => setShowCode(false)}
					/>
				</div>
				<textarea
					ref={codeRef}
					className="min-h-0 w-full flex-1 resize-none border-0 bg-vscode-editor-background p-3 font-mono text-vscode-editor-foreground"
					aria-label={t("common:mermaid.modal.codeTitle")}
					readOnly
					value={code}
				/>
				<div className="flex shrink-0 justify-end gap-2 border-t border-vscode-editorGroup-border p-2">
					<IconButton
						icon={showCopyFeedback ? "check" : "copy"}
						title={t("common:mermaid.buttons.copy")}
						onClick={handleCopy}
					/>
					<IconButton icon="save" title={t("common:mermaid.buttons.save")} onClick={() => void onSave()} />
				</div>
			</Modal>
		</>
	)
}
