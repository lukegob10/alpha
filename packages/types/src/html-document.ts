import { z } from "zod"

/** Version 1 is ordinary HTML with declarative table data; only packaged code executes. */
export const HTML_DOCUMENT_VERSION = "1"
export const HTML_DOCUMENT_VIEW_TYPE = "alpha.htmlDocument"
export const HTML_DOCUMENT_LIMITS = {
	panels: 8,
	bytes: 512 * 1024,
	nodes: 12000,
	depth: 64,
	widgets: 32,
	references: 1000,
	images: 8,
	imageBytes: 1024 * 1024,
	imageTotalBytes: 4 * 1024 * 1024,
	imageTotalPixels: 8 * 1024 * 1024,
	refreshDelayMs: 150,
} as const

export const htmlDocumentTargetSchema = z
	.object({
		uri: z.string().min(1).max(8192),
		taskId: z
			.string()
			.regex(/^[a-zA-Z0-9_-]{1,128}$/)
			.optional(),
	})
	.strict()
export type HtmlDocumentTarget = z.infer<typeof htmlDocumentTargetSchema>

/** This parses an explicit action, never an ordinary HTML/file link. Host scopes the URI. */
export function parseHtmlDocumentLink(value: unknown): HtmlDocumentTarget | undefined {
	if (typeof value !== "string" || value.length > 12000) return undefined
	try {
		const url = new URL(value)
		if (
			url.protocol !== "alpha-document:" ||
			url.host !== "open" ||
			url.pathname !== "" ||
			url.hash ||
			url.username ||
			url.password
		)
			return undefined
		const keys = [...url.searchParams.keys()]
		if (keys.some((key) => key !== "uri" && key !== "task") || new Set(keys).size !== keys.length) return undefined
		const result = htmlDocumentTargetSchema.safeParse({
			uri: url.searchParams.get("uri"),
			taskId: url.searchParams.get("task") ?? undefined,
		})
		return result.success ? result.data : undefined
	} catch {
		return undefined
	}
}

const messageBase = z.object({
	documentId: z.string().min(1).max(8192),
	token: z.string().regex(/^[a-f0-9]{48}$/),
	revision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
})
export const htmlDocumentMessageSchema = z.discriminatedUnion("action", [
	messageBase.extend({ action: z.literal("ready") }).strict(),
	messageBase.extend({ action: z.literal("source") }).strict(),
	messageBase.extend({ action: z.literal("reference"), referenceId: z.string().regex(/^ref-\d{1,4}$/) }).strict(),
])
export type HtmlDocumentMessage = z.infer<typeof htmlDocumentMessageSchema>

export type HtmlDocumentReference = { kind: "source"; path: string; line: number } | { kind: "external"; url: string }
