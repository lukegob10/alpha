import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { afterEach, describe, expect, it } from "vitest"

type KitWindow = Window &
	typeof globalThis & {
		AlphaDocumentKit: { version: string; mount: (root: Element, labels?: Record<string, string>) => () => void }
	}
// Keep jsdom isolated from vitest.setup.ts, which replaces HTMLElement.focus.
const { JSDOM } = createRequire(import.meta.url)("jsdom") as {
	JSDOM: new (html: string, options: { runScripts: string }) => { window: KitWindow }
}
const runtime = readFileSync("public/artifact-kit/v1/kit.js", "utf8")
const windows: KitWindow[] = []

function fixture(content: string, version = "1") {
	const { window } = new JSDOM(`<main class="alpha-doc" data-alpha-kit="${version}">${content}</main>`, {
		runScripts: "outside-only",
	})
	windows.push(window)
	window.eval(runtime)
	const root = window.document.querySelector("main")!
	return { window, root, mount: () => window.AlphaDocumentKit.mount(root) }
}

const table = `<section data-alpha-table><label>Find <input data-alpha-filter disabled></label>
<table><thead><tr><th data-sort="text"><em>File</em></th><th data-sort="number">Count</th></tr></thead><tbody>
<tr id="a"><th><a data-source="src/a.ts" data-line="4">Alpha</a></th><td data-sort-value="2">2</td></tr>
<tr id="b"><th><a data-source="src/b.ts" data-line="9">Beta</a></th><td data-sort-value="">Missing</td></tr>
<tr id="c"><th><a data-source="src/c.ts" data-line="12">Gamma</a></th><td data-sort-value="0">0</td></tr>
<tr id="d"><th><a data-source="src/d.ts" data-line="17">Delta</a></th><td data-sort-value="2">2</td></tr>
</tbody></table></section>`
const order = (root: Element) => [...root.querySelectorAll("tbody tr")].map((row) => row.id)
function chart(values: string[], type = "line") {
	return `<figure data-alpha-chart data-chart-type="${type}"><figcaption>Requests per day; measured fixture</figcaption>
<table data-alpha-chart-data><thead><tr><th>Day</th><th data-unit="requests">Completed</th></tr></thead><tbody>${values
		.map((value, i) => `<tr><th>Day ${i + 1}</th><td data-value="${value}">${value || "Not available"}</td></tr>`)
		.join("")}</tbody></table></figure>`
}

afterEach(() => {
	for (const window of windows.splice(0)) window.close()
})

describe("Alpha HTML kit tables", () => {
	it("sorts complete rows stably, keeping missing values last in both directions", () => {
		const { root, mount } = fixture(table)
		const rows = [...root.querySelectorAll("tbody tr")]
		mount()
		const button = root.querySelectorAll<HTMLButtonElement>("thead button")[1]
		button.click()
		expect(order(root)).toEqual(["c", "a", "d", "b"])
		button.click()
		expect(order(root)).toEqual(["a", "d", "c", "b"])
		for (const row of rows) expect(root.querySelector(`#${row.id}`)).toBe(row)
		expect(root.querySelector("#c a")?.getAttribute("data-source")).toBe("src/c.ts")
		expect(root.querySelectorAll("th[aria-sort]")).toHaveLength(1)
		expect(button.closest("th")?.getAttribute("aria-sort")).toBe("descending")
	})

	it("filters after sorting without mixing row data and source references", () => {
		const { root, mount, window } = fixture(table)
		mount()
		root.querySelectorAll<HTMLButtonElement>("thead button")[1].click()
		const input = root.querySelector<HTMLInputElement>("input")!
		expect(input.disabled).toBe(false)
		input.value = "  GAMMA "
		input.dispatchEvent(new window.Event("input", { bubbles: true }))
		const visible = [...root.querySelectorAll<HTMLTableRowElement>("tbody tr")].filter((row) => !row.hidden)
		expect(visible.map((row) => row.id)).toEqual(["c"])
		expect(visible[0].querySelector("a")?.getAttribute("data-line")).toBe("12")
		expect(visible[0].cells[1].textContent).toBe("0")
		expect(root.querySelector('[role="status"]')?.textContent).toBe("1 of 4 rows")
		input.value = "not present"
		input.dispatchEvent(new window.Event("input"))
		expect(root.querySelector('[role="status"]')?.textContent).toBe("0 of 4 rows")
	})

	it("disposes listeners and restores original header nodes, row order and hidden state", () => {
		const { root, mount, window } = fixture(table)
		const originalHeader = root.querySelector("em")!
		const row = root.querySelector<HTMLTableRowElement>("#b")!
		row.hidden = true
		const dispose = mount()
		const button = root.querySelectorAll<HTMLButtonElement>("thead button")[1]
		button.click()
		const input = root.querySelector<HTMLInputElement>("input")!
		input.value = "Gamma"
		input.dispatchEvent(new window.Event("input"))
		dispose()
		expect(root.querySelector("em")).toBe(originalHeader)
		expect(order(root)).toEqual(["a", "b", "c", "d"])
		expect(row.hidden).toBe(true)
		expect(root.querySelector<HTMLTableRowElement>("#a")!.hidden).toBe(false)
		expect(input.disabled).toBe(true)
		expect(root.querySelector(".kit-status")).toBeNull()
		button.click()
		input.dispatchEvent(new window.Event("input"))
		expect(order(root)).toEqual(["a", "b", "c", "d"])
		expect(root.querySelector<HTMLTableRowElement>("#a")!.hidden).toBe(false)
	})

	it("does not duplicate controls or disposers on repeated mount", () => {
		const { root, mount } = fixture(table)
		const dispose = mount()
		expect(mount()).toBe(dispose)
		expect(root.querySelectorAll("thead button")).toHaveLength(2)
		dispose()
		expect(mount()).not.toBe(dispose)
		expect(root.querySelectorAll("thead button")).toHaveLength(2)
	})

	it.each([
		"<table><tbody><tr><td>Readable without a header</td></tr></tbody></table>",
		"<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>Ragged row</td></tr></tbody></table>",
		`<table><thead><tr><th>A</th></tr></thead><tbody>${"<tr><td>Large</td></tr>".repeat(1001)}</tbody></table>`,
	])("leaves malformed or oversized tables readable with an explanation", (markup) => {
		const { root, mount } = fixture(`<section data-alpha-table>${markup}</section>`)
		const originalTable = root.querySelector("table")
		expect(mount).not.toThrow()
		expect(root.querySelector("table")).toBe(originalTable)
		expect(root.querySelector(".kit-status")?.textContent).toContain("Table enhancement is unavailable")
		expect(root.querySelector("button")).toBeNull()
	})
})

describe("Alpha HTML kit charts", () => {
	it("plots zero, preserves missing observations and breaks line segments at gaps", () => {
		const { root, mount, window } = fixture(chart(["0", "2", "", "3", "4"]))
		const originalTable = root.querySelector("table")
		const dispose = mount()
		expect(root.querySelectorAll("svg circle")).toHaveLength(4)
		expect(root.querySelectorAll("svg polyline")).toHaveLength(2)
		expect(root.querySelector("table")).toBe(originalTable)
		const zero = root.querySelector('circle[aria-label="Day 1, Completed: 0 requests"]')!
		expect(zero).not.toBeNull()
		expect(root.querySelector('circle[aria-label*="Day 3"]')).toBeNull()
		zero.dispatchEvent(new window.FocusEvent("focus"))
		expect(root.querySelector('[role="status"]')?.textContent).toBe("Day 1, Completed: 0 requests")
		dispose()
		expect(root.querySelector("svg")).toBeNull()
		expect(root.querySelector("table")).toBe(originalTable)
	})

	it("keeps negative and zero bars finite and inspectable", () => {
		const { root, mount } = fixture(chart(["-2", "0", "3"], "bar"))
		mount()
		const bars = [...root.querySelectorAll("svg rect")]
		expect(bars).toHaveLength(3)
		for (const bar of bars) {
			for (const name of ["x", "y", "width", "height"])
				expect(Number.isFinite(Number(bar.getAttribute(name)))).toBe(true)
			expect(Number(bar.getAttribute("height"))).toBeGreaterThan(0)
			expect(bar.getAttribute("tabindex")).toBe("0")
		}
	})

	it.each(
		[[], [""], ["NaN"], ["Infinity"], ["1000000000001"], Array<string>(121).fill("1")].map((values) => ({
			values,
		})),
	)("rejects empty, invalid and unbounded data without hiding the table", ({ values }) => {
		const { root, mount } = fixture(chart(values))
		mount()
		expect(root.querySelector("svg")).toBeNull()
		expect(root.querySelector("table")).not.toBeNull()
		expect(root.querySelector(".kit-status")?.textContent).toContain("Chart enhancement is unavailable")
	})

	it("handles missing chart headers without aborting other enhancements", () => {
		const { root, mount } = fixture(
			'<figure data-alpha-chart data-chart-type="bar"><figcaption>Broken fixture</figcaption><table data-alpha-chart-data><tbody><tr><th>A</th><td data-value="1">1</td></tr></tbody></table></figure>' +
				table,
		)
		expect(mount).not.toThrow()
		expect(root.querySelector("figure .kit-status")?.textContent).toContain("Chart enhancement is unavailable")
		expect(root.querySelectorAll("thead button")).toHaveLength(2)
	})

	it("recalculates the report's conclusions from its canonical data", () => {
		const html = readFileSync("public/artifact-kit/v1/examples/report.html", "utf8")
		const { root } = fixture(html)
		const values = [
			...root
				.querySelectorAll("[data-alpha-chart-data]")[0]
				.querySelectorAll<HTMLTableCellElement>("td[data-value]"),
		].map((cell) => Number(cell.dataset.value))
		expect(values).toEqual([3.4, 3.1, 3.2, 3.5, 3.4, 3.3, 3, 2.9, 2.5, 2.4, 2.6, 2.7, 2.9])
		expect(values.at(-1)! - values[0]).toBeCloseTo(-0.5)
		expect(values.at(-1)! - Math.min(...values)).toBeCloseTo(0.5)
		expect(Math.max(...values) - Math.min(...values)).toBeCloseTo(1.1)
		const selected = [
			...root
				.querySelectorAll("[data-alpha-chart-data]")[1]
				.querySelectorAll<HTMLTableCellElement>("td[data-value]"),
		].map((cell) => Number(cell.dataset.value))
		expect(selected).toEqual([values[0], values[9], values[12]])
	})

	it("enhances nested data tables in a keyboard-scrollable chart region and cleans up", () => {
		const markup = chart(["0", "2"])
			.replace("<table", '<section class="evidence"><table')
			.replace("</table>", "</table></section>")
		const { root, mount } = fixture(markup)
		const dispose = mount()
		const region = root.querySelector<HTMLElement>(".kit-chart-scroll")!
		expect(region.tabIndex).toBe(0)
		expect(region.querySelector("svg")).not.toBeNull()
		expect(root.querySelector("table")?.previousElementSibling).toBe(region)
		dispose()
		expect(root.querySelector(".kit-chart-scroll")).toBeNull()
		expect(root.querySelector(".evidence table")).not.toBeNull()
	})

	it("rejects ambiguous merged chart cells and keeps their evidence visible", () => {
		const { root, mount } = fixture(chart(["1"]).replace('<td data-value="1"', '<td colspan="2" data-value="1"'))
		mount()
		expect(root.querySelector("svg")).toBeNull()
		expect(root.querySelector("td")?.textContent).toBe("1")
	})
})

describe("Alpha HTML kit navigation and versions", () => {
	it("makes disposal idempotent even after mounting a new revision", () => {
		const { root, mount } = fixture(table)
		const first = mount()
		first()
		const second = mount()
		first()
		expect(mount()).toBe(second)
		expect(root.querySelectorAll("thead button")).toHaveLength(2)
		second()
		expect(root.querySelectorAll("thead button")).toHaveLength(0)
	})
	it("moves real keyboard focus between tabs, wraps, and restores panel semantics", () => {
		const { root, mount, window } = fixture(
			'<section data-alpha-tabs aria-label="Decision detail"><section id="first" data-tab-label="Choice">One</section><section id="second" data-tab-label="Evidence">Two</section></section>',
		)
		const dispose = mount()
		const tabs = [...root.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
		tabs[0].focus()
		expect(window.document.activeElement).toBe(tabs[0])
		for (const [key, index] of [
			["ArrowRight", 1],
			["ArrowRight", 0],
			["End", 1],
			["Home", 0],
			["ArrowLeft", 1],
		] as const) {
			window.document.activeElement!.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true }))
			expect(window.document.activeElement).toBe(tabs[index])
			expect(tabs[index].getAttribute("aria-selected")).toBe("true")
			expect(tabs[index].tabIndex).toBe(0)
			expect(root.querySelector<HTMLElement>(`#${index ? "second" : "first"}`)!.hidden).toBe(false)
			expect(root.querySelector<HTMLElement>(`#${index ? "second" : "first"}`)!.tabIndex).toBe(0)
		}
		dispose()
		expect(root.querySelector('[role="tablist"]')).toBeNull()
		expect(root.querySelector("#second")?.hasAttribute("hidden")).toBe(false)
		expect(root.querySelector("#first")?.hasAttribute("role")).toBe(false)
	})

	it("shows readable fallback and no controls for unsupported versions", () => {
		const { root, mount } = fixture(table, "999")
		mount()
		expect(root.textContent).toContain("Alpha")
		expect(root.querySelector("button")).toBeNull()
		expect(root.querySelector(".kit-status")?.textContent).toContain('data-alpha-kit="1"')
	})
})
