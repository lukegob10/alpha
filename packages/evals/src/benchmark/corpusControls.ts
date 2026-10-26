/** Public authoring controls. These files are never copied into candidate task workspaces. */
type Patch = Record<string, string>

export type CorpusControl = {
	id: string
	fixture: string
	command: string
	args: string[]
	reference: Patch
	alternative: Patch
	mutants: Array<{ id: string; patch: Patch }>
}

const normalize = (body: string): Patch => ({
	"src/workflow.js": `export function normalize(value) { ${body} }\nexport const workflowIdentity = "plumbing-normalize"\n`,
})
const config = (body: string): Patch => ({
	"src/config.js": `export function resolveConfig(defaults, workspace, commandLine) { ${body} }\n`,
})
const receipt = (status: string, output = "output"): Patch => ({
	"src/receipt.js": `export function commandReceipt(exitCode, output) { return { status: ${status}, exitCode, output: ${output} } }\n`,
})
const invoice = (rate: string, total: string): Patch => ({
	"src/policy.js": `export function discountRate(tier) { return ${rate} }\n`,
	"src/invoice.js": `import { discountRate } from "./policy.js"\nexport function invoice(items, tier = "standard") {
	const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0)
	const discount = subtotal * discountRate(tier)
	return { subtotal, discount, total: ${total} }
}\n`,
})
const pythonReport = (body: string): string => `def build_report(records, status="ready"):\n${body}\n`
const reportReference = pythonReport(`    totals = {}
    for record in records:
        if record["status"] == status:
            totals[record["sku"]] = totals.get(record["sku"], 0) + record["quantity"]
    return [{"sku": sku, "quantity": totals[sku]} for sku in sorted(totals)]`)
const reportAlternative = pythonReport(`    keys = sorted({row["sku"] for row in records if row["status"] == status})
    return [{"sku": sku, "quantity": sum(row["quantity"] for row in records if row["status"] == status and row["sku"] == sku)} for sku in keys]`)
const pythonCli = (call: string): string => `import argparse
import json
from .records import read_records
from .report import build_report

def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("input")
    parser.add_argument("--status", default="ready")
    options = parser.parse_args(argv)
    with open(options.input, encoding="utf-8", newline="") as stream:
        records = read_records(stream)
    print(json.dumps(${call}))

if __name__ == "__main__":
    main()
`

export const corpusControls: CorpusControl[] = [
	{
		id: "smoke-v2-plumbing",
		fixture: "javascript/plumbing-normalize",
		command: "node",
		args: ["--test", "test/behavior.test.js"],
		reference: normalize("return String(value).trim().toUpperCase()"),
		alternative: normalize('const text = `${value}`; return text.trim().toLocaleUpperCase("en-US")'),
		mutants: [
			{ id: "missing-trim", patch: normalize("return String(value).toUpperCase()") },
			{ id: "missing-case", patch: normalize("return String(value).trim()") },
			{ id: "text-only", patch: normalize("return value.trim().toUpperCase()") },
		],
	},
	{
		id: "smoke-v2-config",
		fixture: "javascript/config-overrides",
		command: "node",
		args: ["--test", "test/behavior.test.js"],
		reference: config(`const result = {}; for (const layer of [defaults, workspace, commandLine]) {
			for (const [key, value] of Object.entries(layer)) if (value !== undefined) result[key] = value
		} return result`),
		alternative:
			config(`const keys = new Set([...Object.keys(defaults), ...Object.keys(workspace), ...Object.keys(commandLine)])
			return Object.fromEntries([...keys].flatMap((key) => {
				const layer = [commandLine, workspace, defaults].find((candidate) => candidate[key] !== undefined)
				return layer ? [[key, layer[key]]] : []
			}))`),
		mutants: [
			{ id: "undefined-overwrites", patch: config("return { ...defaults, ...workspace, ...commandLine }") },
			{
				id: "drops-false-values",
				patch: config(`const result = { ...defaults }; for (const layer of [workspace, commandLine]) {
				for (const [key, value] of Object.entries(layer)) if (value) result[key] = value
			} return result`),
			},
			{
				id: "ignores-workspace",
				patch: config(`const result = { ...defaults }; for (const [key, value] of Object.entries(commandLine)) {
				if (value !== undefined) result[key] = value
			} return result`),
			},
		],
	},
	{
		id: "smoke-v2-receipts",
		fixture: "javascript/command-receipts",
		command: "node",
		args: ["--test", "test/behavior.test.js"],
		reference: receipt('exitCode === null ? "pending" : exitCode === 0 ? "success" : "error"'),
		alternative: receipt('new Map([[null, "pending"], [0, "success"]]).get(exitCode) ?? "error"'),
		mutants: [
			{ id: "pending-is-success", patch: receipt('exitCode ? "error" : "success"') },
			{
				id: "negative-is-success",
				patch: receipt('exitCode === null ? "pending" : exitCode > 0 ? "error" : "success"'),
			},
			{
				id: "truncates-output",
				patch: receipt('exitCode === null ? "pending" : exitCode === 0 ? "success" : "error"', "output.trim()"),
			},
		],
	},
	{
		id: "smoke-v2-invoice",
		fixture: "javascript/invoice-integration",
		command: "node",
		args: ["--test", "test/behavior.test.js"],
		reference: invoice('tier === "member" ? 0.1 : 0', "subtotal - discount"),
		alternative: {
			"src/policy.js": "export const discountRate = (tier) => ({ member: 0.1, standard: 0 })[tier] ?? 0\n",
			"src/invoice.js": `import { discountRate } from "./policy.js"
export function invoice(items, tier = "standard") {
	let subtotal = 0
	for (const { price, quantity } of items) subtotal += price * quantity
	const discount = discountRate(tier) * subtotal
	return { subtotal, total: subtotal - discount, discount }
}\n`,
		},
		mutants: [
			{ id: "policy-only", patch: invoice('tier === "member" ? 0.1 : 0', "subtotal") },
			{ id: "all-customers-discounted", patch: invoice("0.1", "subtotal - discount") },
			{ id: "wrong-rate", patch: invoice('tier === "member" ? 0.2 : 0', "subtotal - discount") },
		],
	},
	{
		id: "python-inventory-report",
		fixture: "python/inventory-report",
		command: "python",
		args: ["-B", "-m", "unittest", "discover", "-s", "test", "-v"],
		reference: {
			"inventory/report.py": reportReference,
			"inventory/cli.py": pythonCli("build_report(records, options.status)"),
		},
		alternative: {
			"inventory/report.py": reportAlternative,
			"inventory/cli.py": pythonCli("build_report(status=options.status, records=records)"),
		},
		mutants: [
			{
				id: "drops-cli-status",
				patch: {
					"inventory/report.py": reportReference,
					"inventory/cli.py": pythonCli("build_report(records)"),
				},
			},
			{
				id: "wrong-status",
				patch: {
					"inventory/report.py": reportReference.replace("== status", "!= status"),
					"inventory/cli.py": pythonCli("build_report(records, options.status)"),
				},
			},
			{
				id: "overwrites-quantities",
				patch: {
					"inventory/report.py": reportReference.replace(
						'totals.get(record["sku"], 0) + record["quantity"]',
						'record["quantity"]',
					),
					"inventory/cli.py": pythonCli("build_report(records, options.status)"),
				},
			},
		],
	},
]
