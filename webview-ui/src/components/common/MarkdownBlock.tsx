import React, { lazy, memo, Suspense, useMemo } from "react"
import ReactMarkdown, { defaultUrlTransform } from "react-markdown"
import { parseHtmlDocumentLink } from "@alpha-code/types"
import styled from "styled-components"
import { visit } from "unist-util-visit"
import rehypeKatex from "rehype-katex"
import remarkMath from "remark-math"
import remarkGfm from "remark-gfm"

import { vscode } from "@src/utils/vscode"
import { useAppTranslation } from "@src/i18n/TranslationContext"

import CodeBlock from "./CodeBlock"

const MermaidBlock = lazy(() => import("./MermaidBlock"))

function MermaidLoading() {
	const { t } = useAppTranslation()
	return <div role="status">{t("common:mermaid.loading")}</div>
}

function MarkdownTable({ children, node: _node, ...props }: React.ComponentProps<"table"> & { node?: unknown }) {
	const { t } = useAppTranslation()
	return (
		<div className="table-wrapper" role="group" aria-label={t("common:markdown.table")} tabIndex={0}>
			<table {...props}>{children}</table>
		</div>
	)
}

interface MarkdownBlockProps {
	markdown?: string
	partial?: boolean
}

const WINDOWS_ABSOLUTE_PATH = /^[a-z]:(?:[\\/]|%5c|%2f)/i
const NETWORK_PATH = /^(?:[\\/]|%5c|%2f){2}/i

/** The URL transform and click handler must agree before exposing native file navigation. */
function getMarkdownFilePath(href: string | undefined): string | undefined {
	if (!href || /^[#?]/.test(href) || NETWORK_PATH.test(href)) return undefined
	let filePath = href
	if (/^file:/i.test(href)) {
		if (!/^file:\/\//i.test(href)) return undefined
		try {
			const url = new URL(href)
			if (url.hostname || url.search || url.hash || /%(?:2f|5c)/i.test(url.pathname)) return undefined
			filePath = url.pathname.replace(/^\/(?=[a-z]:\/)/i, "")
			if (NETWORK_PATH.test(filePath)) return undefined
		} catch {
			return undefined
		}
	} else if (!WINDOWS_ABSOLUTE_PATH.test(href) && /^[a-z][a-z0-9+.-]*:/i.test(href)) {
		// A root filename with a line suffix resembles a dotted URI scheme; expose it only as a relative URL.
		return /^[^\\/:?#\s]+\.[^\\/:?#\s]+:\d+(?:-\d+)?$/.test(href) ? `./${href}` : undefined
	}
	// CommonMark percent-encodes backslashes; keep drive paths absolute before the host resolves them.
	return WINDOWS_ABSOLUTE_PATH.test(filePath) ? filePath.replace(/%5c|%2f|\\/gi, "/") : filePath
}

const ensureCodeFenceLanguage = () => {
	return (tree: any) => {
		visit(tree, "code", (node: any) => {
			if (!node.lang) {
				node.lang = "text"
			} else if (node.lang.includes(".")) {
				node.lang = node.lang.split(".").slice(-1)[0]
			}
		})
	}
}

const StyledMarkdown = styled.div`
	font-weight: 400;

	strong {
		font-weight: 600;
	}

	code:not(pre > code) {
		font-family: var(--vscode-editor-font-family, monospace);
		font-size: 0.9em;
		color: var(--vscode-textPreformat-foreground, var(--vscode-foreground));
		background-color: var(--vscode-textPreformat-background, var(--surface-raised));
		padding: 1px 5px;
		border-radius: 4px;
		white-space: pre-line;
		word-break: break-word;
		overflow-wrap: anywhere;
	}

	/* Target only Dark High Contrast theme using the data attribute VS Code adds to the body */
	body[data-vscode-theme-kind="vscode-high-contrast"] & code:not(pre > code) {
		color: var(
			--vscode-editorInlayHint-foreground,
			var(--vscode-symbolIcon-stringForeground, var(--vscode-charts-orange, #e9a700))
		);
	}

	/* KaTeX styling */
	.katex {
		font-size: 1.1em;
		color: var(--vscode-editor-foreground);
		font-family: KaTeX_Main, "Times New Roman", serif;
		line-height: 1.2;
		white-space: normal;
		text-indent: 0;
	}

	.katex-display {
		display: block;
		margin: 1em 0;
		text-align: center;
		padding: 0.5em;
		overflow-x: auto;
		overflow-y: hidden;
		background-color: var(--vscode-textCodeBlock-background);
		border-radius: 3px;
	}

	.katex-error {
		color: var(--vscode-errorForeground);
	}

	font-family:
		var(--vscode-font-family),
		system-ui,
		-apple-system,
		BlinkMacSystemFont,
		"Segoe UI",
		Roboto,
		Oxygen,
		Ubuntu,
		Cantarell,
		"Open Sans",
		"Helvetica Neue",
		sans-serif;

	font-size: var(--vscode-font-size, 13px);

	p,
	li,
	ol,
	ul {
		line-height: 1.65;
	}

	li {
		margin: 0.25em 0;
	}

	ol,
	ul {
		padding-left: 1.75em;
		margin-left: 0;
	}

	ol {
		list-style-type: decimal;
	}

	ul {
		list-style-type: disc;
	}

	ol ol {
		list-style-type: lower-alpha;
	}

	ol ol ol {
		list-style-type: lower-roman;
	}

	p {
		white-space: pre-wrap;
		margin: 0.75em 0;
	}

	blockquote {
		margin: 0.85em 0;
		padding: 0.45em 0.85em;
		border-inline-start: 2px solid
			var(--vscode-contrastBorder, var(--vscode-textBlockQuote-border, var(--border-subtle)));
		border-start-end-radius: 6px;
		border-end-end-radius: 6px;
		background: var(--vscode-textBlockQuote-background, var(--surface-raised));
	}

	> :first-child,
	blockquote > :first-child {
		margin-top: 0;
	}

	> :last-child,
	blockquote > :last-child {
		margin-bottom: 0;
	}

	/* Prevent layout shifts during streaming */
	pre {
		min-height: 3em;
		transition: height 0.2s ease-out;
	}

	/* Code block container styling */
	div:has(> pre) {
		position: relative;
		contain: layout style;
		padding: 0.5em 1em;
	}

	.markdown-code-block {
		--code-block-background: var(--vscode-textCodeBlock-background, var(--surface-raised));
		margin: 1em 0;
		overflow: hidden;
		border: 1px solid var(--border-subtle, var(--vscode-panel-border));
		border-radius: 8px;
	}

	a {
		color: var(--vscode-textLink-foreground);
		text-decoration: none;
		text-decoration-color: var(--vscode-textLink-foreground);
		&:hover {
			color: var(--vscode-textLink-activeForeground);
			text-decoration: underline;
		}
	}

	:is(h1, h2, h3, h4, h5, h6) {
		margin: 1.15em 0 0.45em;
		font-weight: 600;
		line-height: 1.3;
	}

	h1 {
		font-size: 1.65em;
		font-weight: 700;
	}

	h2 {
		font-size: 1.35em;
	}

	h3 {
		font-size: 1.2em;
	}

	/* Table styles for remark-gfm */
	table {
		border-collapse: separate;
		border-spacing: 0;
		width: 100%;
		line-height: 1.55;
	}

	/* Table wrapper for horizontal scrolling */
	.table-wrapper {
		overflow-x: auto;
		margin: 1em 0;
		border: 1px solid var(--border-subtle, var(--vscode-panel-border));
		border-radius: 8px;

		&:focus-visible {
			outline: 1px solid var(--vscode-focusBorder);
			outline-offset: 2px;
		}
	}

	th,
	td {
		padding: 8px 12px;
		text-align: left;
		vertical-align: top;
		overflow-wrap: anywhere;
		min-width: 6em;
	}

	th {
		background-color: var(--surface-raised, var(--vscode-editor-background));
		border-bottom: 1px solid var(--border-subtle, var(--vscode-panel-border));
		font-weight: 600;
		color: var(--vscode-foreground);
	}

	tbody tr + tr td {
		border-top: 1px solid var(--border-subtle, var(--vscode-panel-border));
	}

	tbody tr:hover {
		background-color: var(--vscode-list-hoverBackground);
	}
`

const MarkdownBlock = memo(({ markdown, partial = false }: MarkdownBlockProps) => {
	const components = useMemo(
		() => ({
			table: MarkdownTable,
			a: ({ href, children, ...props }: any) => {
				const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
					if (!href) {
						e.preventDefault()
						return
					}
					if (parseHtmlDocumentLink(href)) {
						e.preventDefault()
						vscode.postMessage({ type: "openHtmlDocument", text: href })
						return
					}
					let filePath = getMarkdownFilePath(href)
					if (filePath === undefined) return

					e.preventDefault()

					// Extract line number if present
					const match = filePath.match(/(.*):(\d+)(-\d+)?$/)
					let values = undefined
					if (match) {
						filePath = match[1]
						values = { line: parseInt(match[2]) }
					}

					// Add ./ prefix if needed
					if (
						!filePath.startsWith("/") &&
						!filePath.startsWith("./") &&
						!WINDOWS_ABSOLUTE_PATH.test(filePath)
					) {
						filePath = "./" + filePath
					}

					vscode.postMessage({
						type: "openFile",
						text: filePath,
						values,
					})
				}

				return (
					<a {...props} href={href || undefined} onClick={handleClick}>
						{children}
					</a>
				)
			},
			pre: ({ children, ..._props }: any) => {
				// The structure from react-markdown v9 is: pre > code > text
				const codeEl = children as React.ReactElement

				if (!codeEl || !codeEl.props) {
					return <pre>{children}</pre>
				}

				const { className = "", children: codeChildren } = codeEl.props

				// Get the actual code text
				let codeString = ""
				if (typeof codeChildren === "string") {
					codeString = codeChildren
				} else if (Array.isArray(codeChildren)) {
					codeString = codeChildren.filter((child) => typeof child === "string").join("")
				}

				// Handle mermaid diagrams
				if (className.includes("language-mermaid")) {
					return (
						<div style={{ margin: "1em 0" }}>
							{partial ? (
								<CodeBlock source={codeString} language="mermaid" partial />
							) : (
								<Suspense fallback={<MermaidLoading />}>
									<MermaidBlock code={codeString} />
								</Suspense>
							)}
						</div>
					)
				}

				// Extract language from className
				const match = /language-(\w+)/.exec(className)
				const language = match ? match[1] : "text"

				return (
					<div className="markdown-code-block">
						<CodeBlock source={codeString} language={language} partial={partial} />
					</div>
				)
			},
			code: ({ children, className, ...props }: any) => {
				// This handles inline code
				return (
					<code className={className} {...props}>
						{children}
					</code>
				)
			},
		}),
		[partial],
	)

	if (partial) {
		return (
			<StyledMarkdown>
				<p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{markdown || ""}</p>
			</StyledMarkdown>
		)
	}

	return (
		<StyledMarkdown>
			<ReactMarkdown
				urlTransform={(url, key) => {
					if (key !== "href") return defaultUrlTransform(url)
					if (parseHtmlDocumentLink(url)) return url
					const filePath = getMarkdownFilePath(url)
					if (filePath === undefined) return defaultUrlTransform(url)
					return filePath.startsWith("./") ? filePath : url
				}}
				remarkPlugins={[remarkGfm, remarkMath, ensureCodeFenceLanguage]}
				rehypePlugins={[rehypeKatex as any]}
				components={components}>
				{markdown || ""}
			</ReactMarkdown>
		</StyledMarkdown>
	)
})

export default MarkdownBlock
