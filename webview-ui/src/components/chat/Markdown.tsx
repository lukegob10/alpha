import { memo } from "react"

import { useCopyToClipboard } from "@src/utils/clipboard"
import { StandardTooltip } from "@src/components/ui"
import { parseProposedPlan } from "@alpha/plan-mode"

import MarkdownBlock from "../common/MarkdownBlock"

export const Markdown = memo(({ markdown, partial }: { markdown?: string; partial?: boolean }) => {
	// Shorter feedback duration for copy button flash.
	const { copyWithFeedback, showCopyFeedback } = useCopyToClipboard(200)

	if (!markdown || markdown.length === 0) {
		return null
	}

	const proposedPlan = parseProposedPlan(markdown, partial === true)
	const renderedMarkdown = proposedPlan?.content ?? markdown

	return (
		<div
			className="group"
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
			{renderedMarkdown && !partial && (
				<div
					className="opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
					style={{
						position: "absolute",
						bottom: "-4px",
						right: "8px",
						borderRadius: "4px",
					}}>
					<StandardTooltip content="Copy as markdown">
						<button
							type="button"
							aria-label="Copy as markdown"
							className="copy-button cursor-pointer"
							style={{
								height: "24px",
								padding: "3px",
								border: "none",
								borderRadius: "5px",
								color: "var(--vscode-foreground)",
								background: showCopyFeedback
									? "var(--vscode-button-background)"
									: "var(--vscode-editor-background)",
								transition: "background 0.2s ease-in-out",
							}}
							onClick={() => copyWithFeedback(renderedMarkdown)}>
							<span className="codicon codicon-copy" />
						</button>
					</StandardTooltip>
				</div>
			)}
		</div>
	)
})
