import { memo, type ReactNode } from "react"

import { parseProposedPlan } from "@alpha/plan-mode"

import MarkdownBlock from "../common/MarkdownBlock"
import { MessageActions } from "./MessageActions"

interface MarkdownProps {
	markdown?: string
	partial?: boolean
	actions?: ReactNode
	onRestart?: () => void
	restartDisabled?: boolean
}

export const Markdown = memo(({ markdown, partial, actions, onRestart, restartDisabled }: MarkdownProps) => {
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
			<MessageActions text={renderedMarkdown} onRestart={onRestart} disabled={restartDisabled || partial}>
				{!partial && actions}
			</MessageActions>
		</div>
	)
})
