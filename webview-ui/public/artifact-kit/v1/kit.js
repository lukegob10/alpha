/* Alpha HTML kit v1. Trusted, dependency-free enhancement; no host or network access. */
/* global window, document */
;(function () {
	"use strict"
	const mounted = new WeakMap()
	const defaults = {
		filter: "Filter rows",
		sort: "Sort by {column}",
		rows: "{visible} of {total} rows",
		unsupported: 'This kit version is not supported. Open the source and use data-alpha-kit="1".',
		invalidTable:
			"Table enhancement is unavailable. Use a rectangular table with one header row and at most 1,000 rows and 20 columns.",
		invalidChart:
			"Chart enhancement is unavailable. Check the data table: up to 120 rows, three series, one shared unit, and finite numeric values; leave missing values empty.",
		invalidTabs: "Tabs are unavailable. Give each section a unique ID and a tab label.",
		missing: "Missing",
		inspect: "Chart values are available in the data table. Focus a plotted value to inspect it.",
		sortAscending: "ascending",
		sortDescending: "descending",
	}
	function mount(root, labels = {}) {
		if (mounted.has(root)) return mounted.get(root)
		const doc = root.ownerDocument
		const cleanups = []
		let disposed = false
		const t = (key, values = {}) =>
			(typeof labels[key] === "string" ? labels[key] : defaults[key]).replace(/\{(\w+)\}/g, (match, name) =>
				String(values[name] ?? match),
			)
		function listen(node, event, handler) {
			node.addEventListener(event, handler)
			cleanups.push(() => node.removeEventListener(event, handler))
		}
		function add(parent, tag, text, className) {
			const node = doc.createElement(tag)
			if (text !== undefined) node.textContent = text
			if (className) node.className = className
			parent.append(node)
			cleanups.push(() => node.remove())
			return node
		}
		function notice(parent, key) {
			return add(parent, "p", t(key), "kit-status")
		}
		function dispose() {
			if (disposed) return
			disposed = true
			for (const cleanup of cleanups.reverse()) cleanup()
			mounted.delete(root)
		}
		mounted.set(root, dispose)
		if (root.getAttribute("data-alpha-kit") !== "1") {
			notice(root, "unsupported")
			return dispose
		}

		for (const wrapper of root.querySelectorAll("[data-alpha-table]")) {
			const table = wrapper.querySelector("table")
			const heads = table ? Array.from(table.tHead?.rows[0]?.cells ?? []) : []
			const body = table?.tBodies[0]
			const rows = Array.from(body?.rows ?? [])
			if (
				!table ||
				table.tHead?.rows.length !== 1 ||
				table.tBodies.length !== 1 ||
				!heads.length ||
				heads.length > 20 ||
				rows.length > 1000 ||
				rows.some((row) => row.cells.length !== heads.length) ||
				[...heads, ...rows.flatMap((row) => Array.from(row.cells))].some(
					(cell) => cell.colSpan !== 1 || cell.rowSpan !== 1,
				)
			) {
				notice(wrapper, "invalidTable")
				continue
			}
			const hidden = rows.map((row) => row.hidden)
			cleanups.push(() =>
				rows.forEach((row, i) => {
					body.append(row)
					row.hidden = hidden[i]
				}),
			)
			const status = notice(wrapper, "rows")
			status.setAttribute("role", "status")
			const update = () => {
				status.textContent = t("rows", {
					visible: rows.filter((row) => !row.hidden).length,
					total: rows.length,
				})
			}
			const filter = wrapper.querySelector("input[data-alpha-filter]")
			if (filter) {
				const disabled = filter.disabled
				const aria = filter.getAttribute("aria-label")
				filter.disabled = false
				if (!filter.labels?.length && !aria) filter.setAttribute("aria-label", t("filter"))
				cleanups.push(() => {
					filter.disabled = disabled
					if (aria === null) filter.removeAttribute("aria-label")
				})
				const search = rows.map((row) => row.textContent.toLocaleLowerCase())
				const applyFilter = () => {
					const value = filter.value.trim().toLocaleLowerCase()
					rows.forEach((row, i) => {
						row.hidden = !search[i].includes(value)
					})
					update()
				}
				listen(filter, "input", applyFilter)
				applyFilter()
			}
			for (const [column, head] of heads.entries()) {
				if (!["number", "text"].includes(head.dataset.sort)) continue
				const original = Array.from(head.childNodes)
				const title = head.textContent
				const priorSort = head.getAttribute("aria-sort")
				head.replaceChildren()
				cleanups.push(() => {
					head.replaceChildren(...original)
					if (priorSort === null) head.removeAttribute("aria-sort")
					else head.setAttribute("aria-sort", priorSort)
				})
				const button = add(head, "button", title)
				button.type = "button"
				button.setAttribute("aria-label", t("sort", { column: title }))
				listen(button, "click", () => {
					const ascending = head.getAttribute("aria-sort") !== "ascending"
					heads.forEach((item) => item.removeAttribute("aria-sort"))
					head.setAttribute("aria-sort", ascending ? "ascending" : "descending")
					const value = (row) => {
						const cell = row.cells[column]
						const raw = cell.getAttribute("data-sort-value") ?? cell.textContent.trim()
						return head.dataset.sort === "number"
							? raw !== "" && Number.isFinite(Number(raw))
								? Number(raw)
								: null
							: raw.toLocaleLowerCase()
					}
					const sorted = rows
						.map((row, index) => ({ row, index, value: value(row) }))
						.sort((a, b) => {
							if (a.value === null) return b.value === null ? a.index - b.index : 1
							if (b.value === null) return -1
							const order = a.value < b.value ? -1 : a.value > b.value ? 1 : 0
							return (ascending ? order : -order) || a.index - b.index
						})
					body.append(...sorted.map((item) => item.row))
					status.textContent = `${title}: ${t(ascending ? "sortAscending" : "sortDescending")}. ${t("rows", { visible: rows.filter((row) => !row.hidden).length, total: rows.length })}`
				})
			}
			update()
		}

		for (const figure of root.querySelectorAll("[data-alpha-chart]")) {
			const table = figure.querySelector("table[data-alpha-chart-data]")
			const heads = Array.from(table?.tHead?.rows[0]?.cells ?? [])
			const rows = Array.from(table?.tBodies[0]?.rows ?? [])
			const type = figure.dataset.chartType
			const series = heads.slice(1)
			const unit = series[0]?.getAttribute("data-unit")
			const values = rows.slice(0, 120).map((row) =>
				Array.from(row.cells)
					.slice(1, 4)
					.map((cell) => {
						const raw = cell.getAttribute("data-value")
						return raw === ""
							? null
							: raw === null || !/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(raw)
								? NaN
								: Number(raw)
					}),
			)
			if (
				!table ||
				table.tHead?.rows.length !== 1 ||
				table.tBodies.length !== 1 ||
				!["bar", "line"].includes(type) ||
				!figure.querySelector("figcaption")?.textContent.trim() ||
				!unit ||
				series.length < 1 ||
				series.length > 3 ||
				series.some((head) => head.getAttribute("data-unit") !== unit) ||
				rows.length < 1 ||
				rows.length > 120 ||
				rows.some((row) => row.cells.length !== heads.length || !row.cells[0].textContent.trim()) ||
				[...heads, ...rows.flatMap((row) => Array.from(row.cells))].some(
					(cell) => cell.colSpan !== 1 || cell.rowSpan !== 1,
				) ||
				values.flat().some((value) => value !== null && (!Number.isFinite(value) || Math.abs(value) > 1e12)) ||
				!values.flat().some((value) => value !== null)
			) {
				notice(figure, "invalidChart")
				continue
			}
			const ns = "http://www.w3.org/2000/svg"
			const svg = doc.createElementNS(ns, "svg")
			svg.setAttribute("viewBox", "0 0 720 300")
			svg.setAttribute("class", "kit-chart")
			svg.setAttribute("role", "group")
			svg.setAttribute("aria-label", figure.querySelector("figcaption").textContent.trim())
			const viewport = add(figure, "div", undefined, "kit-chart-scroll")
			viewport.tabIndex = 0
			viewport.setAttribute("role", "group")
			viewport.setAttribute("aria-label", figure.querySelector("figcaption").textContent.trim())
			viewport.append(svg)
			table.parentNode.insertBefore(viewport, table)
			cleanups.push(() => svg.remove())
			const status = notice(figure, "inspect")
			status.setAttribute("role", "status")
			function shape(tag, attrs, text) {
				const el = doc.createElementNS(ns, tag)
				for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value))
				if (text !== undefined) el.textContent = text
				svg.append(el)
				return el
			}
			const all = values.flat().filter((value) => value !== null)
			const min = Math.min(0, ...all),
				max = Math.max(0, ...all)
			const span = max - min || 1
			const y = (value) => 245 - ((value - min) / span) * 205
			const x = (index) => 70 + ((index + 0.5) / rows.length) * 610
			shape("line", { x1: 60, x2: 690, y1: y(0), y2: y(0), class: "axis" })
			for (const value of new Set([min, max]))
				shape("text", { x: 55, y: y(value) + 4, "text-anchor": "end" }, String(value))
			shape("text", { x: 60, y: 18 }, unit)
			for (const [s, head] of series.entries()) {
				shape("line", {
					x1: 65 + s * 205,
					x2: 87 + s * 205,
					y1: 290,
					y2: 290,
					class: `series-${s}`,
					"stroke-width": 3,
					"stroke-dasharray": s === 0 ? "none" : s === 1 ? "6 3" : "2 3",
				})
				shape("text", { x: 94 + s * 205, y: 295 }, `${s + 1}. ${head.textContent.trim().slice(0, 22)}`)
				let segment = []
				const flush = () => {
					if (segment.length > 1)
						shape("polyline", {
							points: segment.join(" "),
							class: `series-${s}`,
							"stroke-dasharray": s === 0 ? "none" : s === 1 ? "6 3" : "2 3",
						})
					segment = []
				}
				for (const [i, row] of rows.entries()) {
					const value = values[i][s]
					if (value === null) {
						flush()
						continue
					}
					const label = `${row.cells[0].textContent.trim()}, ${head.textContent.trim()}: ${value} ${unit}`
					const width = Math.min(40, 540 / rows.length / series.length)
					const point =
						type === "bar"
							? shape("rect", {
									x: x(i) + (s - series.length / 2) * width,
									y: Math.min(y(0), y(value)),
									width: Math.max(1, width - 2),
									height: Math.max(1, Math.abs(y(value) - y(0))),
									class: `series-${s}`,
								})
							: shape("circle", { cx: x(i), cy: y(value), r: 4 + s, class: `series-${s}` })
					point.setAttribute("tabindex", "0")
					if (type === "bar" && series.length > 1)
						shape(
							"text",
							{
								x: x(i) + (s - series.length / 2) * width + width / 2,
								y: Math.min(y(0), y(value)) - 6,
								"text-anchor": "middle",
							},
							String(s + 1),
						)
					point.setAttribute("role", "img")
					point.setAttribute("aria-label", label)
					const title = doc.createElementNS(ns, "title")
					title.textContent = label
					point.append(title)
					listen(point, "focus", () => {
						status.textContent = label
					})
					listen(point, "pointerenter", () => {
						status.textContent = label
					})
					if (type === "line") segment.push(`${x(i)},${y(value)}`)
				}
				flush()
			}
			const stride = Math.max(1, Math.ceil(rows.length / 5))
			rows.forEach((row, i) => {
				if (i % stride === 0 || i === rows.length - 1)
					shape(
						"text",
						{ x: x(i), y: 268, "text-anchor": "middle" },
						row.cells[0].textContent.trim().slice(0, 14),
					)
			})
		}

		for (const wrapper of root.querySelectorAll("[data-alpha-tabs]")) {
			const panels = Array.from(wrapper.children).filter((child) => child.hasAttribute("data-tab-label"))
			if (
				panels.length < 2 ||
				panels.length > 8 ||
				panels.some(
					(panel) =>
						!panel.id ||
						!panel.dataset.tabLabel?.trim() ||
						Array.from(doc.querySelectorAll("[id]")).filter((node) => node.id === panel.id).length !== 1 ||
						doc.getElementById(`${panel.id}-alpha-tab`),
				)
			) {
				notice(wrapper, "invalidTabs")
				continue
			}
			const list = add(wrapper, "div")
			list.setAttribute("role", "tablist")
			list.setAttribute(
				"aria-label",
				wrapper.getAttribute("aria-label") ?? panels.map((panel) => panel.dataset.tabLabel).join(" / "),
			)
			wrapper.prepend(list)
			const buttons = panels.map((panel, i) => {
				const button = add(list, "button", panel.dataset.tabLabel)
				button.type = "button"
				button.setAttribute("role", "tab")
				button.setAttribute("aria-controls", panel.id)
				button.id = `${panel.id}-alpha-tab`
				const previous = [
					panel.hidden,
					panel.getAttribute("role"),
					panel.getAttribute("aria-labelledby"),
					panel.getAttribute("tabindex"),
				]
				cleanups.push(() => {
					panel.hidden = previous[0]
					for (const [index, name] of ["role", "aria-labelledby", "tabindex"].entries()) {
						if (previous[index + 1] === null) panel.removeAttribute(name)
						else panel.setAttribute(name, previous[index + 1])
					}
				})
				panel.setAttribute("role", "tabpanel")
				panel.tabIndex = 0
				panel.setAttribute("aria-labelledby", button.id)
				listen(button, "click", () => select(i))
				listen(button, "keydown", (event) => {
					const next =
						event.key === "ArrowRight"
							? (i + 1) % panels.length
							: event.key === "ArrowLeft"
								? (i + panels.length - 1) % panels.length
								: event.key === "Home"
									? 0
									: event.key === "End"
										? panels.length - 1
										: null
					if (next !== null) {
						event.preventDefault()
						select(next)
						buttons[next].focus()
					}
				})
				return button
			})
			function select(index) {
				panels.forEach((panel, i) => {
					panel.hidden = i !== index
					buttons[i].setAttribute("aria-selected", String(i === index))
					buttons[i].tabIndex = i === index ? 0 : -1
				})
			}
			select(0)
		}
		return dispose
	}
	window.AlphaDocumentKit = Object.freeze({ version: "1", mount })
	// Only standalone galleries opt in. The viewer invokes mount after sanitization.
	if (document.currentScript?.hasAttribute("data-alpha-standalone")) {
		const start = () => document.querySelectorAll(".alpha-doc[data-alpha-kit]").forEach((root) => mount(root))
		if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true })
		else start()
	}
})()
