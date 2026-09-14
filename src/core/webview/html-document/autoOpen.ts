import {
	HTML_DOCUMENT_LIMITS,
	parseHtmlDocumentLink,
	type ClineMessage,
	type HtmlDocumentTarget,
} from "@alpha-code/types"

/** Presentation-only deduplication for live completion events; history snapshots never enter this path. */
export class HtmlDocumentAutoOpen {
	private readonly delivered = new WeakMap<object, Set<string>>()

	constructor(private readonly open: (target: HtmlDocumentTarget, isCurrent: () => boolean) => Promise<void>) {}

	async handle(owner: object, taskId: string, message: ClineMessage, isCurrent: () => boolean): Promise<void> {
		if (!isCurrent() || message.type !== "say" || message.say !== "completion_result" || message.partial === true)
			return
		const seen = this.delivered.get(owner) ?? new Set<string>()
		this.delivered.set(owner, seen)
		let fence: { character: string; length: number } | undefined
		let opened = 0
		for (const line of (message.text ?? "").split("\n")) {
			const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line)
			if (marker) {
				if (!fence) fence = { character: marker[1][0], length: marker[1].length }
				else if (marker[1][0] === fence.character && marker[1].length >= fence.length && !marker[2].trim())
					fence = undefined
				continue
			}
			if (fence || /^(?: {4}|\t)/.test(line)) continue
			const prose = line.replace(/(`+).*?\1/g, "")
			for (const match of prose.matchAll(/(?<!!)\[[^\]\r\n]+\]\((alpha-document:\/\/open\?[^\s<>()]+)\)/g)) {
				const target = parseHtmlDocumentLink(match[1])
				if (!target || (target.taskId !== undefined && target.taskId !== taskId)) continue
				const key = process.platform === "win32" ? target.uri.toLowerCase() : target.uri
				if (seen.has(key)) continue
				if (!isCurrent() || opened >= HTML_DOCUMENT_LIMITS.panels) return
				seen.add(key) // Claim before awaiting so duplicate live deliveries cannot open twice.
				if (seen.size > 128) seen.delete(seen.values().next().value!)
				opened++
				await this.open({ ...target, taskId }, isCurrent)
			}
		}
	}
}
