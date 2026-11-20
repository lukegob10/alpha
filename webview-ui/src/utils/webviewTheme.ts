type WebviewTheme = "light" | "dark" | "high-contrast" | "high-contrast-light"

const listeners = new Set<() => void>()
let observer: MutationObserver | undefined

export function getWebviewTheme(): WebviewTheme {
	const classes = document.body.classList
	if (classes.contains("vscode-high-contrast-light")) return "high-contrast-light"
	if (classes.contains("vscode-high-contrast")) return "high-contrast"
	return classes.contains("vscode-light") ? "light" : "dark"
}

export function subscribeToWebviewTheme(listener: () => void): () => void {
	listeners.add(listener)
	if (!observer) {
		let theme = getWebviewTheme()
		observer = new MutationObserver(() => {
			const next = getWebviewTheme()
			if (next === theme) return
			theme = next
			for (const notify of listeners) notify()
		})
		observer.observe(document.body, { attributes: true, attributeFilter: ["class"] })
	}
	return () => {
		listeners.delete(listener)
		if (listeners.size === 0) {
			observer?.disconnect()
			observer = undefined
		}
	}
}
