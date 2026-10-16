import { TextDecoder } from "node:util"

const MAX_XML_DECLARATION_LENGTH = 1024
const XML_DECLARATION_START = /<\?xml(?=[\t\r\n ?>])/i
const XML_DECLARATION =
	/^<\?xml[\t\r\n ]+version[\t\r\n ]*=[\t\r\n ]*(?:"1\.0"|'1\.0')(?:[\t\r\n ]+encoding[\t\r\n ]*=[\t\r\n ]*(?:"[Uu][Tt][Ff]-8"|'[Uu][Tt][Ff]-8'))?(?:[\t\r\n ]+standalone[\t\r\n ]*=[\t\r\n ]*(?:"(?:yes|no)"|'(?:yes|no)'))?[\t\r\n ]*\?>$/

/** SVG inputs admit UTF-8 only; native XML parsing never receives a DTD or entity declaration. */
export function isSvgSourceAllowed(bytes: Uint8Array, maxBytes: number): boolean {
	if (
		!(bytes instanceof Uint8Array) ||
		!(bytes.buffer instanceof ArrayBuffer) ||
		bytes.length === 0 ||
		bytes.length > maxBytes ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 0
	) {
		return false
	}
	let source: string
	try {
		// Fatal decoding rejects malformed UTF-8; the prefix/declaration checks reject ambiguous encodings.
		// TextDecoder admits and removes only the leading UTF-8 BOM; the approved bytes remain unchanged.
		source = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
	} catch {
		return false
	}
	if (!/^[\t\r\n ]*</.test(source)) return false
	if (source.includes("\0") || /<![\t\r\n ]*(?:DOCTYPE|ENTITY)\b/i.test(source)) return false
	const declaration = XML_DECLARATION_START.exec(source)
	if (declaration !== null) {
		const end = source.indexOf("?>")
		if (declaration.index !== 0 || end < 0 || end + 2 > MAX_XML_DECLARATION_LENGTH) return false
		if (!XML_DECLARATION.test(source.slice(0, end + 2))) return false
		if (XML_DECLARATION_START.test(source.slice(end + 2))) return false
	}
	// This conservative token rule also rejects declarations quoted inside comments or CDATA.
	return true
}
