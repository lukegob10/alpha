import { parentPort } from "node:worker_threads"
import { sanitizeDocument, type DocumentParseRequest } from "../core/webview/html-document/sanitize"

parentPort?.on("message", ({ source, documentDirectory }: DocumentParseRequest) => {
	try {
		parentPort?.postMessage({ document: sanitizeDocument(source, documentDirectory) })
	} catch (error) {
		parentPort?.postMessage({ error: error instanceof Error ? error.message : "format" })
	}
})
