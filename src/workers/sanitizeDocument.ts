import { parentPort } from "node:worker_threads"
import { sanitizeDocument } from "../core/webview/html-document/sanitize"

parentPort?.on("message", (source: string) => {
	try {
		parentPort?.postMessage({ document: sanitizeDocument(source) })
	} catch (error) {
		parentPort?.postMessage({ error: error instanceof Error ? error.message : "format" })
	}
})
