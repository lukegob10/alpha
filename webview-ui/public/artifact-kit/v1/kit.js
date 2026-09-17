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
		invalidDiagram:
			"Diagram unavailable. Use a three-column relationship table with at most 24 named nodes, 48 links, and no cycles. The table remains readable.",
		imageUnavailable:
			"Image unavailable. Check the workspace path and use a static PNG or JPEG within the documented size limits.",
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

		for (const nav of root.querySelectorAll("nav[data-alpha-toc]")) {
			const headings = [...root.querySelectorAll("h2[id],h3[id]")]
				.filter((heading) => !heading.closest("nav,details,[data-alpha-tabs]") && heading.textContent.trim())
				.slice(0, 200)
			if (!headings.length) continue
			const list = add(nav, "ol", undefined, "document-outline")
			for (const heading of headings) {
				const item = add(list, "li", undefined, heading.tagName === "H3" ? "outline-child" : undefined)
				const text = heading.textContent.trim()
				const link = add(item, "a", text.length > 160 ? text.slice(0, 159) + "…" : text)
				link.setAttribute("href", `#${heading.id}`)
			}
		}
		for (const img of root.querySelectorAll("img")) {
			const failed = () => {
				if (disposed || img.nextElementSibling?.classList.contains("image-unavailable")) return
				const message = add(
					img.parentElement,
					"p",
					`${img.alt} — ${t("imageUnavailable")}`,
					"image-unavailable",
				)
				img.after(message)
			}
			listen(img, "error", failed)
			if (img.complete && !img.naturalWidth) failed()
		}

		// Relationships remain canonical table rows. Only this trusted runtime
		// draws SVG; authored SVG, scripts and layout expressions are unsupported.
		for (const figure of root.querySelectorAll("figure[data-alpha-diagram]")) {
			const table = figure.querySelector("table")
			if (table && table.closest("figure[data-alpha-diagram]") !== figure) continue
			const label = figure.querySelector("figcaption")?.textContent.trim() || table?.caption?.textContent.trim()
			const rows = [...(table?.tBodies[0]?.rows ?? [])]
			const edges = rows.map((row) => [...row.cells].map((cell) => cell.textContent.trim()))
			const names = [...new Set(edges.flatMap((edge) => [edge[0], edge[2]]))]
			if (
				!table ||
				!label ||
				table.tHead?.rows.length !== 1 ||
				table.tHead.rows[0].cells.length !== 3 ||
				table.tBodies.length !== 1 ||
				!edges.length ||
				edges.length > 48 ||
				names.length > 24 ||
				edges.some((edge) => edge.length !== 3 || edge.some((label) => !label || label.length > 80)) ||
				[...table.rows].some((row) => [...row.cells].some((cell) => cell.colSpan !== 1 || cell.rowSpan !== 1))
			) {
				notice(figure, "invalidDiagram")
				continue
			}
			const remaining = new Set(names)
			const layers = []
			while (remaining.size) {
				const layer = names.filter(
					(name) => remaining.has(name) && !edges.some(([from, , to]) => to === name && remaining.has(from)),
				)
				if (!layer.length) break
				layers.push(layer)
				for (const name of layer) remaining.delete(name)
			}
			if (remaining.size) {
				notice(figure, "invalidDiagram")
				continue
			}
			const width = Math.max(420, layers.length * 250)
			const nodeHeight = Math.max(...layers.map((layer) => layer.length)) * 140 + 40
			const ranks = new Map(layers.flatMap((layer, rank) => layer.map((name) => [name, rank])))
			const longEdges = edges.filter(([from, , to]) => ranks.get(to) - ranks.get(from) > 1).length
			const height = nodeHeight + longEdges * 14
			const region = add(figure, "div", undefined, "diagram-scroll")
			let tableContainer = table
			while (tableContainer.parentElement !== figure) tableContainer = tableContainer.parentElement
			figure.insertBefore(region, tableContainer)
			region.tabIndex = 0
			region.setAttribute("role", "region")
			region.setAttribute("aria-label", label)
			const svgNode = (tag, attributes, parent) => {
				const node = doc.createElementNS("http://www.w3.org/2000/svg", tag)
				for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value))
				parent.append(node)
				return node
			}
			const svg = svgNode(
				"svg",
				{ viewBox: `0 0 ${width} ${height}`, width, height, "aria-hidden": "true" },
				region,
			)
			const positions = new Map(
				layers.flatMap((layer, x) => layer.map((name, y) => [name, { x: 20 + x * 250, y: 20 + y * 140 }])),
			)
			let lane = 0
			for (const [from, , to] of edges) {
				const a = positions.get(from),
					b = positions.get(to)
				const x = a.x + 180,
					y = a.y + 50,
					endX = b.x - 8,
					endY = b.y + 50
				// Skipping a layer must not draw through an unrelated intermediate node.
				const routeY = nodeHeight + lane * 14
				const skipsLayer = b.x - a.x > 250
				if (skipsLayer) lane++
				svgNode(
					"path",
					{
						d: skipsLayer
							? `M${x},${y} H${x + 20} V${routeY} H${endX - 20} V${endY} H${endX}`
							: `M${x},${y} C${x + 35},${y} ${endX - 35},${endY} ${endX},${endY}`,
						class: "diagram-edge",
					},
					svg,
				)
				svgNode(
					"path",
					{ d: `M${endX - 6},${endY - 5} L${endX},${endY} L${endX - 6},${endY + 5}`, class: "diagram-edge" },
					svg,
				)
			}
			for (const [name, { x, y }] of positions) {
				svgNode("rect", { x, y, width: 180, height: 100, rx: 6, class: "diagram-node" }, svg)
				const lines = name.match(/[\s\S]{1,20}/g) || [name]
				for (const [index, line] of lines.entries())
					svgNode("text", { x: x + 12, y: y + 25 + index * 20, class: "diagram-label" }, svg).textContent =
						line.trim()
			}
		}

		for (const wrapper of root.querySelectorAll("[data-alpha-table]")) {
			const table = wrapper.querySelector("table")
			if (table && table.closest("[data-alpha-table]") !== wrapper) continue
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
			if (table && table.closest("[data-alpha-chart]") !== figure) continue
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
				!unit?.trim() ||
				series.length < 1 ||
				series.length > 3 ||
				series.some((head) => !head.textContent.trim() || head.getAttribute("data-unit") !== unit) ||
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
			const x = (index) => 100 + ((index + 0.5) / rows.length) * 590
			shape("line", { x1: 95, x2: 705, y1: y(0), y2: y(0), class: "axis" })
			for (const value of new Set([min, max])) {
				const magnitude = Math.abs(value)
				const tick =
					magnitude >= 10000 || (magnitude > 0 && magnitude < 0.001)
						? value.toExponential(2).replace(/\.?0+e/, "e")
						: String(Number(value.toPrecision(3)))
				shape(
					"text",
					{ x: 85, y: y(value) + 4, "text-anchor": "end" },
					`${Number(tick) === value ? "" : "≈"}${tick}`,
				)
			}
			shape("text", { x: 95, y: 18 }, unit)
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
