import { githubToolApprovalSchema } from "@alpha-code/types"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { ToolUseBlock, ToolUseBlockHeader } from "../common/ToolUseBlock"

export function GitHubApiActivity({ request }: { request: unknown }) {
	const { t } = useAppTranslation()
	const parsed = githubToolApprovalSchema.safeParse(request)
	if (!parsed.success) return null
	const { action, owner, repo, title, body, message, ...details } = parsed.data
	const metadata = Object.fromEntries(Object.entries(details).filter(([, value]) => value !== undefined))
	return (
		<ToolUseBlock>
			<ToolUseBlockHeader>
				<span>GitHub · {t(`chat:githubActions.${action ?? "request"}`)}</span>
			</ToolUseBlockHeader>
			<div className="min-w-0 space-y-2 p-3">
				<div className="break-all text-vscode-descriptionForeground">
					{owner}/{repo}
				</div>
				{title !== undefined && <div className="whitespace-pre-wrap break-words font-semibold">{title}</div>}
				{Object.keys(metadata).length > 0 && (
					<pre className="whitespace-pre-wrap break-words text-xs">{JSON.stringify(metadata, null, 2)}</pre>
				)}
				{body !== undefined && <pre className="whitespace-pre-wrap break-words font-sans text-sm">{body}</pre>}
				{message !== undefined && (
					<pre className="whitespace-pre-wrap break-words font-sans text-sm">{message}</pre>
				)}
			</div>
		</ToolUseBlock>
	)
}
