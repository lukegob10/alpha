import { FileCode2, ArrowUpRight } from "lucide-react"
import { vscode } from "@src/utils/vscode"

interface CodebaseSearchResultProps {
	filePath: string
	startLine: number
	endLine: number
	context?: string
	snippet: string
}

export default function CodebaseSearchResult({
	filePath,
	startLine,
	endLine,
	context,
	snippet,
}: CodebaseSearchResultProps) {
	const normalizedPath = filePath.replace(/\\/g, "/")
	const parts = normalizedPath.split("/")
	const filename = parts.pop()
	const directory = parts.join("/")
	const lines = startLine === endLine ? String(startLine) : `${startLine}–${endLine}`
	const scope = context?.split("\n")[0].trim()
	const preview = snippet.trim().split("\n").slice(0, 3).join("\n")

	return (
		<button
			type="button"
			title={`${normalizedPath}:${lines}`}
			onClick={() =>
				vscode.postMessage({ type: "openFile", text: "./" + normalizedPath, values: { line: startLine } })
			}
			className="flex w-full min-w-0 items-start gap-2.5 rounded-md px-2 py-2.5 text-left text-vscode-foreground hover:bg-vscode-list-hoverBackground focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-2 focus-visible:outline-vscode-focusBorder">
			<FileCode2 className="mt-0.5 size-4 shrink-0 text-vscode-descriptionForeground" aria-hidden="true" />
			<span className="min-w-0 flex-1">
				<span className="flex min-w-0 items-baseline gap-2">
					<span className="min-w-0 truncate text-sm font-medium">{filename}</span>
					<span className="shrink-0 text-xs tabular-nums text-vscode-descriptionForeground">{lines}</span>
				</span>
				{directory && (
					<span className="block truncate text-xs text-vscode-descriptionForeground">{directory}</span>
				)}
				{scope && (
					<span className="mt-1 block truncate text-xs text-vscode-descriptionForeground">{scope}</span>
				)}
				{preview && (
					<span className="mt-1 line-clamp-2 whitespace-pre-wrap break-all font-mono text-xs leading-relaxed text-vscode-descriptionForeground">
						{preview}
					</span>
				)}
			</span>
			<ArrowUpRight className="mt-0.5 size-3.5 shrink-0 text-vscode-descriptionForeground" aria-hidden="true" />
		</button>
	)
}
