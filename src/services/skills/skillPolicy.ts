import * as fs from "fs/promises"
import * as path from "path"
import { Composer, Lexer, Parser, type Document } from "yaml"

export const MAX_SKILL_POLICY_BYTES = 64 * 1024
export const MAX_SKILL_POLICY_DEPTH = 64

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function* boundedTokens(raw: string) {
	const parser = new Parser()
	for (const lexeme of new Lexer().lex(raw)) {
		yield* parser.next(lexeme)
		// Bound parser frames before recursive document composition, including block and flow collections.
		if (parser.stack.length > MAX_SKILL_POLICY_DEPTH) throw new Error("Skill metadata nesting limit exceeded")
	}
	yield* parser.end()
}

/** Optional portable metadata never prevents loading the skill itself. */
export function parseSkillInvocationPolicy(raw: string): boolean | undefined {
	if (Buffer.byteLength(raw, "utf8") > MAX_SKILL_POLICY_BYTES) return undefined

	try {
		let document: Document.Parsed | undefined
		for (const candidate of new Composer({ uniqueKeys: true }).compose(boundedTokens(raw), true, raw.length)) {
			if (document) return undefined
			document = candidate
		}
		if (!document || document.errors.length > 0 || document.warnings.length > 0) return undefined
		const metadata: unknown = document.toJS({ maxAliasCount: 0 })
		if (!isRecord(metadata) || !isRecord(metadata.policy)) return undefined
		const value = metadata.policy.allow_implicit_invocation
		return typeof value === "boolean" ? value : undefined
	} catch {
		return undefined
	}
}

export async function readSkillInvocationPolicy(skillDir: string): Promise<boolean | undefined> {
	const metadataPath = path.join(skillDir, "agents", "openai.yaml")
	try {
		const file = await fs.open(metadataPath, "r")
		try {
			const stats = await file.stat()
			if (!stats.isFile() || stats.size > MAX_SKILL_POLICY_BYTES) return undefined

			// Read a bounded buffer even if metadata grows after the stat check.
			const buffer = Buffer.alloc(MAX_SKILL_POLICY_BYTES + 1)
			let length = 0
			while (length < buffer.length) {
				const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
				if (bytesRead === 0) break
				length += bytesRead
			}
			if (length > MAX_SKILL_POLICY_BYTES) return undefined
			return parseSkillInvocationPolicy(buffer.toString("utf8", 0, length))
		} finally {
			await file.close()
		}
	} catch {
		// Missing, unreadable, or malformed optional metadata retains the historical default.
		return undefined
	}
}
