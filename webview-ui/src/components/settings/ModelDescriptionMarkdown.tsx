import { memo } from "react"
import ReactMarkdown from "react-markdown"

import { StyledMarkdown } from "./styles"

/** The containing model-help popover provides scrolling for long provider descriptions. */
export const ModelDescriptionMarkdown = memo(({ markdown = "" }: { markdown?: string }) => {
	return (
		<StyledMarkdown>
			<ReactMarkdown skipHtml>{markdown}</ReactMarkdown>
		</StyledMarkdown>
	)
})
