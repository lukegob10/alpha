import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { t } from "../../i18n"

// Codex 67f0994 uses a per-handler 2,500 approximate-token preview and preserves
// the full text in an OS temporary artifact. Reads still use Alpha's normal policy.
const DEFAULT_TOKEN_LIMIT = 2_500
// Bound the raw envelope across concurrent processes before decoding or parsing.
export const MAX_HOOK_OUTPUT_BYTES = 1_048_576

function preview(text: string, byteBudget: number): string {
	const bytes = Buffer.from(text, "utf8")
	if (bytes.length <= byteBudget) return text
	const marker = `\n${t("common:lifecycleHooks.outputTruncated", { tokens: Math.ceil((bytes.length - byteBudget) / 4) })}\n`
	const available = Math.max(0, byteBudget - Buffer.byteLength(marker))
	let headEnd = Math.ceil(available / 2)
	let tailStart = bytes.length - Math.floor(available / 2)
	// Keep both boundaries on complete UTF-8 code points.
	while (headEnd > 0 && (bytes[headEnd] & 0xc0) === 0x80) headEnd--
	while (tailStart < bytes.length && (bytes[tailStart] & 0xc0) === 0x80) tailStart++
	return `${bytes.subarray(0, headEnd).toString("utf8")}${marker}${bytes.subarray(tailStart).toString("utf8")}`
}

/** Preserve complete feedback without allowing large hook output to dominate the next request. */
export async function preserveHookOutput(text: string, tokenLimit = DEFAULT_TOKEN_LIMIT): Promise<string> {
	if (tokenLimit === 0 || Buffer.byteLength(text, "utf8") <= tokenLimit * 4) return text
	let directory: string | undefined
	try {
		// mkdtemp and exclusive creation keep hook-supplied identifiers and paths out
		// of artifact naming, and prevent following a pre-created file or directory.
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "alpha-hook-output-"))
		const artifact = path.join(directory, "output.txt")
		await fs.writeFile(artifact, text, { encoding: "utf8", flag: "wx", mode: 0o600 })
		const footer = `\n\n${t("common:lifecycleHooks.outputSavedTo", { path: artifact })}`
		return `${preview(text, Math.max(0, tokenLimit * 4 - Buffer.byteLength(footer)))}${footer}`
	} catch {
		if (directory) await fs.rmdir(directory).catch(() => undefined)
		const footer = `\n\n${t("common:lifecycleHooks.outputUnavailable")}`
		return `${preview(text, Math.max(0, tokenLimit * 4 - Buffer.byteLength(footer)))}${footer}`
	}
}
