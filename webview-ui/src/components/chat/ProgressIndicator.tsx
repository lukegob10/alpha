import { LoaderCircle } from "lucide-react"

export const ProgressIndicator = () => (
	<LoaderCircle
		data-testid="progress-indicator"
		className="size-4 shrink-0 animate-spin motion-reduce:animate-none text-[var(--vscode-progressBar-background)]"
		aria-hidden="true"
		focusable="false"
	/>
)
