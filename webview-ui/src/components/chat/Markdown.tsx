import { memo, useState } from "react"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"

import { useCopyToClipboard } from "@src/utils/clipboard"
import { StandardTooltip } from "@src/components/ui"
import { parseProposedPlan } from "@alpha/plan-mode"

import MarkdownBlock from "../common/MarkdownBlock"

export const Markdown = memo(({ markdown, partial }: { markdown?: string; partial?: boolean }) => {
	const [isHovering, setIsHovering] = useState(false)

	// Shorter feedback duration for copy button flash.
	const { copyWithFeedback } = useCopyToClipboard(200)

	if (!markdown || markdown.length === 0) {
		return null
	}

	const proposedPlan = parseProposedPlan(markdown, partial === true)
	const renderedMarkdown = proposedPlan?.content ?? markdown

	return (
		<div
			onMouseEnter={() => setIsHovering(true)}
			onMouseLeave={() => setIsHovering(false)}
			aria-label={proposedPlan ? "Proposed plan" : undefined}
			style={{
				position: "relative",
				...(proposedPlan
					? {
							borderLeft: "3px solid var(--vscode-textLink-foreground)",
							borderRadius: "4px",
							background: "var(--vscode-textBlockQuote-background, var(--vscode-editor-background))",
							padding: "10px 12px 8px",
						}
					: {}),
			}}>
			{proposedPlan && (
				<div
					style={{
						color: "var(--vscode-descriptionForeground)",
						fontSize: "11px",
						fontWeight: 600,
						letterSpacing: "0.04em",
						marginBottom: "6px",
						textTransform: "uppercase",
					}}>
					Proposed plan
				</div>
			)}
			<div style={{ wordBreak: "break-word", overflowWrap: "anywhere" }}>
				<MarkdownBlock markdown={renderedMarkdown} partial={partial} />
			</div>
			{renderedMarkdown && !partial && isHovering && (
				<div
					style={{
						position: "absolute",
						bottom: "-4px",
						right: "8px",
						opacity: 0,
						animation: "fadeIn 0.2s ease-in-out forwards",
						borderRadius: "4px",
					}}>
					<style>{`@keyframes fadeIn { from { opacity: 0; } to { opacity: 1.0; } }`}</style>
					<StandardTooltip content="Copy as markdown">
						<VSCodeButton
							className="copy-button"
							appearance="icon"
							style={{
								height: "24px",
								border: "none",
								background: "var(--vscode-editor-background)",
								transition: "background 0.2s ease-in-out",
							}}
							onClick={async () => {
								const success = await copyWithFeedback(renderedMarkdown)
								if (success) {
									const button = document.activeElement as HTMLElement
									if (button) {
										button.style.background = "var(--vscode-button-background)"
										setTimeout(() => {
											button.style.background = ""
										}, 200)
									}
								}
							}}>
							<span className="codicon codicon-copy" />
						</VSCodeButton>
					</StandardTooltip>
				</div>
			)}
		</div>
	)
})
