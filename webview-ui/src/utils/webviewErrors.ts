import { webviewErrorMessageSchema, type WebviewErrorMessage } from "@alpha-code/types"

import { vscode } from "./vscode"

const reportedErrors = new Set<string>()
const MAX_REPORTS = 10

type ErrorLocation = Partial<Pick<WebviewErrorMessage, "line" | "column" | "resourceType">>

function boundedLocation(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000
		? value
		: undefined
}

/** Only fixed categories and numeric locations leave the renderer; error text remains local. */
export function reportWebviewError(
	source: WebviewErrorMessage["source"],
	error: unknown,
	location: ErrorLocation = {},
): void {
	try {
		if (reportedErrors.size >= MAX_REPORTS) return
		let errorType: WebviewErrorMessage["errorType"] = "other"
		let failure: WebviewErrorMessage["failure"] = source === "resource" ? "resource_load" : "other"
		if (error instanceof Error) {
			const name = webviewErrorMessageSchema.shape.errorType.safeParse(error.name)
			if (name.success) errorType = name.data
			const message = error.message.slice(0, 2_048)
			if (/maximum call stack|too much recursion/i.test(message)) failure = "stack_overflow"
			else if (/invalid string length/i.test(message)) failure = "invalid_string_length"
			else if (
				errorType === "ChunkLoadError" ||
				/failed to fetch dynamically imported module|error loading dynamically imported module|loading chunk/i.test(
					message,
				)
			) {
				failure = "chunk_load"
			}
		}
		const diagnostic: WebviewErrorMessage = {
			type: "webviewError",
			source,
			errorType,
			failure,
			visibility: document.visibilityState === "hidden" ? "hidden" : "visible",
			line: boundedLocation(location.line),
			column: boundedLocation(location.column),
			resourceType: location.resourceType,
		}
		const key = JSON.stringify(diagnostic)
		if (reportedErrors.has(key)) return
		reportedErrors.add(key)
		vscode.postMessage(diagnostic)
	} catch {
		// A failing reporter or unusual thrown object must never break the error screen.
	}
}

export function initializeWebviewErrorReporting(): () => void {
	const onError = (event: Event) => {
		const target = event.target
		if (
			target instanceof HTMLScriptElement ||
			target instanceof HTMLLinkElement ||
			target instanceof HTMLImageElement
		) {
			reportWebviewError("resource", undefined, {
				resourceType:
					target instanceof HTMLScriptElement
						? "script"
						: target instanceof HTMLLinkElement
							? "style"
							: "image",
			})
		} else if (event instanceof ErrorEvent) {
			reportWebviewError("window", event.error, { line: event.lineno, column: event.colno })
		}
	}
	const onRejection = (event: PromiseRejectionEvent) => reportWebviewError("rejection", event.reason)
	window.addEventListener("error", onError, true)
	window.addEventListener("unhandledrejection", onRejection)
	return () => {
		window.removeEventListener("error", onError, true)
		window.removeEventListener("unhandledrejection", onRejection)
	}
}
