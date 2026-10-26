/**
 * Source Map Initializer
 *
 * This utility sets up global error handlers that load source-map support only
 * when an error actually needs to be enhanced.
 *
 * This implementation is compatible with VSCode's Content Security Policy.
 */

async function enhanceError(error: Error) {
	const { enhanceErrorWithSourceMaps } = await import("./sourceMapUtils")
	return enhanceErrorWithSourceMaps(error)
}

/**
 * Initialize source map support for production builds
 */
export function initializeSourceMaps(): () => void {
	if (process.env.NODE_ENV !== "production") {
		// Only needed in production builds
		return () => {}
	}

	// Set up global error handler
	const onError = async (event: ErrorEvent) => {
		if (event.error && event.error instanceof Error) {
			try {
				// Apply source maps to the error
				const enhancedError = await enhanceError(event.error)

				// Log the enhanced error
				console.error("Source mapped error:", enhancedError)

				// Don't prevent default handling - let the ErrorBoundary catch it
			} catch (e) {
				console.error("Error enhancing error with source maps:", e)
			}
		}
	}

	// Set up unhandled promise rejection handler
	const onRejection = async (event: PromiseRejectionEvent) => {
		if (event.reason && event.reason instanceof Error) {
			try {
				// Apply source maps to the error
				const enhancedError = await enhanceError(event.reason)

				// Log the enhanced error
				console.error("Source mapped rejection:", enhancedError)
			} catch (e) {
				console.error("Error enhancing rejection with source maps:", e)
			}
		}
	}
	window.addEventListener("error", onError)
	window.addEventListener("unhandledrejection", onRejection)
	return () => {
		window.removeEventListener("error", onError)
		window.removeEventListener("unhandledrejection", onRejection)
	}
}
