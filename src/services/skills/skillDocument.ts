import matter from "gray-matter"
import { t } from "../../i18n"

/** Accept portable prose scalars without changing the instruction body or executing metadata. */
export function parseImportedSkillDocument(contents: string): ReturnType<typeof matter> {
	const opening = /^(?:\uFEFF)?---([^\r\n]*)/.exec(contents)
	if (opening && opening[1]!.trim()) throw new Error(t("skills:errors.yaml_frontmatter_only"))
	try {
		// gray-matter caches before parsing, including failed parses; fresh options avoid stale failures.
		return matter(contents, {})
	} catch (originalError) {
		const header = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(contents)
		if (!header || header[1]!.length > 64 * 1024) throw originalError
		let blockIndent: number | undefined
		let repaired = false
		const lines = header[1]!.split(/\r?\n/).map((line) => {
			const indent = line.length - line.trimStart().length
			if (blockIndent !== undefined) {
				if (!line.trim() || indent > blockIndent) return line
				blockIndent = undefined
			}
			const field = /^(\s*[^:#]+:\s*)(.*)$/.exec(line)
			if (field && /^[|>][+-]?(?:\s|$)/.test(field[2]!)) {
				blockIndent = indent
				return line
			}
			const scalar = /^(\s*(?:name|description|short-description|argument-hint):\s+)([^\s"'[{|>#!&*].*)$/.exec(
				line,
			)
			if (!scalar || !/:\s/.test(scalar[2]!)) return line
			repaired = true
			return scalar[1] + JSON.stringify(scalar[2]!.trimEnd())
		})
		if (!repaired) throw originalError
		try {
			return matter(`---\n${lines.join("\n")}\n---\n${contents.slice(header[0].length)}`, {})
		} catch {
			throw originalError
		}
	}
}
