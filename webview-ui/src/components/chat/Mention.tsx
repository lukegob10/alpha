import { mentionRegexGlobal, getTicketMentionLocator } from "@alpha/context-mentions"

import { vscode } from "../../utils/vscode"

interface MentionProps {
	text?: string
	withShadow?: boolean
	interactive?: boolean
}

export const Mention = ({ text, withShadow = false, interactive = true }: MentionProps) => {
	if (!text) {
		return <>{text}</>
	}

	const parts = text.split(mentionRegexGlobal).map((part, index) => {
		if (index % 2 === 0) {
			// This is regular text.
			return part
		} else {
			// This is a mention.
			if (getTicketMentionLocator(part))
				return (
					<button
						key={index}
						type="button"
						className={`mention-context-highlight text-[0.9em] ${interactive ? "cursor-pointer" : "pointer-events-none"}`}
						disabled={!interactive}
						onClick={
							interactive ? () => vscode.postMessage({ type: "openMention", text: part }) : undefined
						}>
						@{part}
					</button>
				)
			return (
				<span
					key={index}
					className={`${withShadow ? "mention-context-highlight-with-shadow" : "mention-context-highlight"} text-[0.9em] ${interactive ? "cursor-pointer" : "pointer-events-none"}`}
					onClick={interactive ? () => vscode.postMessage({ type: "openMention", text: part }) : undefined}>
					@{part}
				</span>
			)
		}
	})

	return <>{parts}</>
}
