/* Trusted host adapter. Authored HTML never receives the VS Code API. */
;(() => {
	"use strict"
	const api = acquireVsCodeApi()
	const config = JSON.parse(document.body.dataset.viewerConfig)
	document.body.removeAttribute("data-viewer-config")
	const content = document.getElementById("viewer-content")
	const status = document.getElementById("viewer-status")
	const title = document.getElementById("viewer-title")
	const purifier = window.DOMPurify
	if (!purifier || !config.sanitizer) return
	// Browser reparsing is a separate trust boundary from the host's allowlist.
	purifier.addHook("uponSanitizeAttribute", (_node, attribute) => {
		if (
			attribute.attrName === "src" &&
			!/^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+=*$/.test(attribute.attrValue)
		)
			attribute.keepAttr = false
		if (attribute.attrName === "href" && !/^#(?:[A-Za-z][\w-]{0,127})?$/.test(attribute.attrValue))
			attribute.keepAttr = false
	})
	let revision = 0
	let disposeKit
	let scrollRestore
	let renderedHtml
	const restored = api.getState()
	let previousState = restored?.target?.uri === config.target.uri ? restored.view : undefined
	const capture = () => ({
		scroll: scrollRestore?.position ?? window.scrollY,
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
	const focusTarget = (target) => {
		if (!target) return
		if (target.tabIndex < 0 && !target.hasAttribute("tabindex")) {
			target.setAttribute("tabindex", "-1")
			target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true })
		}
		target.focus({ preventScroll: true })
	}
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
					if (target) {
						target.scrollIntoView()
						focusTarget(target)
					}
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
			message.revision <= revision
		)
			return
		const html = message.html
		if (typeof html === "string" && html.length > config.sanitizer.maxHtmlLength) return
		revision = message.revision
		status.textContent = message.error ? `${message.stale ? message.staleLabel + " " : ""}${message.error}` : ""
		status.hidden = !message.error
		content.dataset.stale = message.stale ? "true" : "false"
		if (typeof html !== "string") return
		if (typeof message.title === "string") {
			if (title.textContent !== message.title) title.textContent = message.title
			if (document.title !== message.title) document.title = message.title
		}
		if (html === renderedHtml) return
		const state = previousState ?? capture()
		// Preserve keyboard position only inside this active document. A refresh
		// while the source editor is focused must never move focus into the preview.
		const focusedId =
			document.hasFocus() && content.contains(document.activeElement) ? document.activeElement.id : ""
		previousState = undefined
		disposeKit?.()
		content.innerHTML = purifier.sanitize(html, {
			ALLOWED_TAGS: config.sanitizer.tags,
			ALLOWED_ATTR: config.sanitizer.attributes,
			ALLOW_DATA_ATTR: false,
			ALLOW_ARIA_ATTR: false,
		})
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
		if (focusedId) focusTarget([...content.querySelectorAll("[id]")].find((node) => node.id === focusedId))
		// Several snapshots can arrive before paint. Keep the original scroll
		// position until the latest content has been laid out.
		if (!scrollRestore) {
			const position = Number.isFinite(state?.scroll) ? Math.max(0, state.scroll) : 0
			scrollRestore = { position }
			scrollRestore.frame = requestAnimationFrame(() => {
				scrollRestore = undefined
				window.scrollTo(0, position)
				persist()
			})
		}
		renderedHtml = html
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
		if (scrollRestore?.frame !== undefined) cancelAnimationFrame(scrollRestore.frame)
		persist()
		scrollRestore = undefined
		disposeKit?.()
	})
	api.setState({ target: config.target, view: previousState })
	send("ready")
})()
