/* Trusted host adapter. Authored HTML never receives the VS Code API. */
;(() => {
	"use strict"
	const api = acquireVsCodeApi()
	const config = JSON.parse(document.body.dataset.viewerConfig)
	document.body.removeAttribute("data-viewer-config")
	const content = document.getElementById("viewer-content")
	const status = document.getElementById("viewer-status")
	const title = document.getElementById("viewer-title")
	let revision = 0
	let disposeKit
	const restored = api.getState()
	let previousState = restored?.target?.uri === config.target.uri ? restored.view : undefined
	const capture = () => ({
		scroll: window.scrollY,
		details: Object.fromEntries([...content.querySelectorAll("details[id]")].map((node) => [node.id, node.open])),
		filters: Object.fromEntries(
			[...content.querySelectorAll("input[data-alpha-filter][id]")].map((node) => [
				node.id,
				node.value.slice(0, 2048),
			]),
		),
	})
	const persist = () => api.setState({ target: config.target, view: capture() })
	const send = (action, extra = {}) =>
		api.postMessage({ action, documentId: config.documentId, token: config.token, revision, ...extra })
	document.getElementById("viewer-source").addEventListener("click", () => send("source"))
	document.addEventListener("submit", (event) => event.preventDefault(), true)
	document.addEventListener(
		"click",
		(event) => {
			const link = event.target.closest("a")
			if (!link) return
			event.preventDefault()
			if (link.dataset.alphaReference) send("reference", { referenceId: link.dataset.alphaReference })
			else {
				const href = link.getAttribute("href")
				if (/^#[A-Za-z][\w-]{0,127}$/.test(href ?? "")) {
					const target = [...content.querySelectorAll("[id]")].find((node) => `#${node.id}` === href)
					target?.scrollIntoView()
				}
			}
		},
		true,
	)
	document.addEventListener("auxclick", (event) => event.preventDefault(), true)
	window.addEventListener("message", (event) => {
		const message = event.data
		if (
			!message ||
			message.type !== "document" ||
			message.documentId !== config.documentId ||
			message.token !== config.token ||
			!Number.isSafeInteger(message.revision) ||
			message.revision < revision
		)
			return
		revision = message.revision
		status.textContent = message.error ? `${message.stale ? message.staleLabel + " " : ""}${message.error}` : ""
		status.hidden = !message.error
		content.dataset.stale = message.stale ? "true" : "false"
		if (typeof message.html !== "string") return
		const state = previousState ?? capture()
		previousState = undefined
		disposeKit?.()
		content.innerHTML = message.html
		if (typeof message.title === "string") {
			title.textContent = message.title
			document.title = message.title
		}
		const root = content.querySelector("main.alpha-doc")
		disposeKit = window.AlphaDocumentKit?.mount(root, config.labels)
		for (const node of content.querySelectorAll("details[id]"))
			if (typeof state?.details?.[node.id] === "boolean") node.open = state.details[node.id]
		for (const node of content.querySelectorAll("input[data-alpha-filter][id]")) {
			if (typeof state?.filters?.[node.id] === "string") {
				node.value = state.filters[node.id].slice(0, 2048)
				node.dispatchEvent(new Event("input", { bubbles: true }))
			}
		}
		requestAnimationFrame(() => {
			window.scrollTo(0, Number.isFinite(state?.scroll) ? Math.max(0, state.scroll) : 0)
			persist()
		})
	})
	let stateTimer
	const scheduleState = () => {
		clearTimeout(stateTimer)
		stateTimer = setTimeout(persist, 100)
	}
	window.addEventListener("scroll", scheduleState, { passive: true })
	content.addEventListener("toggle", scheduleState, true)
	content.addEventListener("input", scheduleState)
	window.addEventListener("pagehide", () => {
		clearTimeout(stateTimer)
		persist()
		disposeKit?.()
	})
	api.setState({ target: config.target, view: previousState })
	send("ready")
})()
