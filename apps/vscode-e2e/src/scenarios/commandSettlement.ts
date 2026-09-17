/** One workload shared by scripted and live runs; the oracle is installed by the host, outside model authority. */
export const MAX_SETTLEMENT_REVISIONS = 12
export const SETTLEMENT_COMMANDS = Array.from(
	{ length: MAX_SETTLEMENT_REVISIONS },
	(_, index) => `node .alpha-receipt-oracle.cjs ${index + 1}`,
)

export function settlementRevisions(value: string | undefined): number[] {
	const count = value === undefined ? 3 : Number(value)
	if (!Number.isInteger(count) || count < 3 || count > MAX_SETTLEMENT_REVISIONS)
		throw new Error("Settlement turns must be between 3 and 12")
	return Array.from({ length: count }, (_, index) => index + 1)
}

export function settlementPrompt(revision: number): string {
	if (!Number.isInteger(revision) || revision < 1 || revision > MAX_SETTLEMENT_REVISIONS)
		throw new Error("Invalid settlement revision")
	return [
		`[command-settlement:${revision}] Work only in this disposable workspace.`,
		"Build a small interactive HTML counter with index.html, app.js, style.css, config.json and README.md.",
		"index.html must load app.js and style.css and contain elements with IDs count, increment, decrement, reset.",
		"app.js runs directly in a browser, uses document.getElementById and addEventListener('click', handler), initializes count.textContent to 0, and makes the three buttons increment, decrement and reset the displayed integer. Use no external libraries or network.",
		`config.json must have revision: ${revision}. Update README.md to describe the controls and revision ${revision}.`,
		"Keep earlier functionality. Use file tools for edits. Do not edit .alphaignore or any .alpha-* file; the host owns the oracle and markers.",
		`Run exactly this approved command with the workspace as cwd and timeout 1: ${SETTLEMENT_COMMANDS[revision - 1]}`,
		"The Node command independently exercises the controls, emits a large output, then writes build-receipt.json after a short delay. Do not write that receipt yourself or rerun a running command. Finish with attempt_completion after it settles.",
		"Do not install dependencies, delegate, use network services, or run any other terminal command.",
	].join("\n")
}

export function settlementScript(revision: number, workspace: string) {
	settlementPrompt(revision)
	const files = {
		"index.html":
			'<!doctype html><link rel="stylesheet" href="style.css"><output id="count">0</output><button id="increment">+</button><button id="decrement">-</button><button id="reset">Reset</button><script src="app.js"></script>',
		"app.js":
			'const count = document.getElementById("count"); let value = 0; const render = () => { count.textContent = String(value) }; for (const id of ["increment", "decrement", "reset"]) document.getElementById(id).addEventListener("click", () => { value = id === "reset" ? 0 : value + (id === "increment" ? 1 : -1); render() }); render();',
		"style.css": `body { font-family: sans-serif; padding: ${revision}rem; }`,
		"config.json": JSON.stringify({ revision }),
		"README.md": `Counter revision ${revision}: increment, decrement, reset.`,
	}
	return [
		...Object.entries(files).map(([path, content]) => ({ name: "write_to_file", arguments: { path, content } })),
		{
			name: "execute_command",
			arguments: { command: SETTLEMENT_COMMANDS[revision - 1], cwd: workspace, timeout: 1 },
		},
		{
			name: "attempt_completion",
			arguments: { result: `Counter revision ${revision} verified.`, outcome: "completed" },
		},
	]
}

export const SETTLEMENT_ORACLE = String.raw`
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const revision = Number(process.argv[2])
assert.ok(Number.isInteger(revision) && revision >= 1 && revision <= 12)
const html = fs.readFileSync('index.html', 'utf8')
assert.match(html, /<script\b[^>]*src=["'](?:\.\/)?app\.js["']/i)
assert.match(html, /href=["'](?:\.\/)?style\.css["']/i)
const elements = new Map(['count', 'increment', 'decrement', 'reset'].map(id => {
  assert.ok(new RegExp('id=["\x27]' + id + '["\x27]').test(html))
  return [id, { textContent: '0', listeners: new Map(), addEventListener(event, handler) { this.listeners.set(event, handler) } }]
}))
vm.runInNewContext(fs.readFileSync('app.js', 'utf8'), { document: { getElementById: id => elements.get(id) } }, { timeout: 1000 })
const click = id => { const element = elements.get(id); const listener = element.listeners.get('click'); assert.equal(typeof listener, 'function'); listener.call(element, { currentTarget: element, target: element, type: 'click' }) }
const value = () => Number(elements.get('count').textContent)
assert.equal(value(), 0)
click('increment'); click('increment'); assert.equal(value(), 2)
click('decrement'); assert.equal(value(), 1)
click('reset'); assert.equal(value(), 0)
click('decrement'); assert.equal(value(), -1)
assert.equal(JSON.parse(fs.readFileSync('config.json', 'utf8')).revision, revision)
assert.ok(fs.readFileSync('README.md', 'utf8').includes(String(revision)))
assert.ok(fs.statSync('style.css').size > 0)
for (let index = 0; index < 256; index++) console.log('output-' + index + ':' + 'x'.repeat(512))
setTimeout(() => {
  fs.writeFileSync('build-receipt.json', JSON.stringify({ revision, checks: 5, passed: true }))
  console.log('HTML controls verified, receipt persisted: ' + revision)
}, 1500)
`
