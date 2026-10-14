export type ProblemSolvingBankControl = {
	id: string
	testFile: string
	target: string
	reference: string
	alternative: string
	broken: string
}

const cacheReference = `export class ConfigCache {
	#raw = new Map()
	#derived = new Map()
	set(key, value) {
		this.#raw.set(key, value)
		this.#derived.clear()
	}
	getPort() {
		if (!this.#derived.has("port")) this.#derived.set("port", Number(this.#raw.get("port") ?? 80))
		return this.#derived.get("port")
	}
	getOrigin() {
		if (!this.#derived.has("origin")) this.#derived.set("origin", \`http://localhost:\${this.getPort()}\`)
		return this.#derived.get("origin")
	}
}
`

const cacheAlternative = `export class ConfigCache {
	#raw = new Map()
	#derived = new Map()
	set(key, value) {
		this.#raw.set(key, value)
		this.#derived.delete(key)
		if (key === "port") this.#derived.delete("origin")
	}
	getPort() {
		if (!this.#derived.has("port")) this.#derived.set("port", Number(this.#raw.get("port") ?? 80))
		return this.#derived.get("port")
	}
	getOrigin() {
		if (!this.#derived.has("origin")) this.#derived.set("origin", \`http://localhost:\${this.getPort()}\`)
		return this.#derived.get("origin")
	}
}
`

const cacheBroken = `export class ConfigCache {
	#raw = new Map()
	set() {}
	getPort() {
		return 80
	}
	getOrigin() {
		return "http://localhost:80"
	}
}
`

const pipelineReference = `export async function exportRecords(records, write, { concurrency = 2, signal } = {}) {
	let index = 0
	const worker = async () => {
		while (index < records.length) {
			if (signal?.aborted) throw signal.reason ?? new Error("aborted")
			const current = index
			index += 1
			if (current >= records.length) return
			await write(records[current], signal)
		}
	}
	const workers = Math.max(1, Math.min(concurrency, records.length))
	await Promise.all(Array.from({ length: workers }, () => worker()))
}
`

const pipelineAlternative = `export async function exportRecords(records, write, { concurrency = 2, signal } = {}) {
	let active = 0
	let cursor = 0
	return new Promise((resolve, reject) => {
		const next = () => {
			if (cursor >= records.length && active === 0) {
				resolve(undefined)
				return
			}
			while (active < concurrency && cursor < records.length) {
				const record = records[cursor]
				cursor += 1
				active += 1
				Promise.resolve()
					.then(() => write(record, signal))
					.then(() => {
						active -= 1
						next()
					})
					.catch(reject)
			}
		}
		next()
	})
}
`

const pipelineBroken = `export async function exportRecords(records, write, { signal } = {}) {
	for (const record of records) await write(record, signal)
}
`

const workspaceReference = `export function buildOrder(packages) {
	const indegree = new Map(packages.map((pkg) => [pkg.name, 0]))
	const dependents = new Map(packages.map((pkg) => [pkg.name, []]))
	for (const pkg of packages) {
		for (const dep of pkg.deps) {
			if (!indegree.has(dep)) throw new Error(\`missing dependency \${dep}\`)
			indegree.set(pkg.name, indegree.get(pkg.name) + 1)
			dependents.get(dep).push(pkg.name)
		}
	}
	const ready = packages.filter((pkg) => indegree.get(pkg.name) === 0).map((pkg) => pkg.name)
	const order = []
	while (ready.length > 0) {
		const name = ready.shift()
		order.push(name)
		for (const next of dependents.get(name)) {
			indegree.set(next, indegree.get(next) - 1)
			if (indegree.get(next) === 0) ready.push(next)
		}
	}
	if (order.length !== packages.length) throw new Error("dependency cycle")
	return order
}
`

const workspaceAlternative = `export function buildOrder(packages) {
	const pending = packages.map((pkg) => ({ name: pkg.name, deps: [...pkg.deps] }))
	const order = []
	while (pending.length > 0) {
		const index = pending.findIndex((pkg) => pkg.deps.length === 0)
		if (index < 0) throw new Error("dependency cycle")
		const [ready] = pending.splice(index, 1)
		order.push(ready.name)
		for (const pkg of pending) pkg.deps = pkg.deps.filter((dep) => dep !== ready.name)
	}
	return order
}
`

const workspaceBroken = `export function buildOrder(packages) {
	return packages.map((pkg) => pkg.name)
}
`

const argvReference = `export function parseArgs(args) {
	const out = { include: [] }
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index]
		if (!arg.startsWith("--")) continue
		const body = arg.slice(2)
		const equals = body.indexOf("=")
		const key = equals === -1 ? body : body.slice(0, equals)
		const value = equals === -1 ? args[++index] : body.slice(equals + 1)
		if (key === "include") out.include.push(value)
		else if (key === "limit") out.limit = Number(value)
		else out[key] = value
	}
	return out
}
`

const argvAlternative = `export function parseArgs(args) {
	const include = []
	let limit
	for (let index = 0; index < args.length; index += 1) {
		const [flag, attached] = args[index].split("=")
		const key = flag.replace(/^--/, "")
		const value = attached === undefined ? args[++index] : attached
		if (key === "include") include.push(value)
		if (key === "limit") limit = Number(value)
	}
	return { limit, include }
}
`

const argvBroken = `export function parseArgs(args) {
	return { limit: args[0], include: [] }
}
`

const pageReference = `export function page(rows, cursor, limit) {
	const ordered = [...rows].sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
	const start = cursor == null || cursor === "" ? 0 : ordered.findIndex((row) => row.id === cursor) + 1
	const items = ordered.slice(start, start + limit)
	const last = items.at(-1)
	return { items, next: last && start + items.length < ordered.length ? last.id : null }
}
`

const pageAlternative = `export function page(rows, cursor, limit) {
	const ordered = rows.slice().sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
	let start = 0
	if (cursor) {
		for (const row of ordered) {
			start += 1
			if (row.id === cursor) break
		}
	}
	const items = []
	for (let index = start; index < ordered.length && items.length < limit; index += 1) items.push(ordered[index])
	const more = start + items.length < ordered.length
	return { items, next: more ? items[items.length - 1].id : null }
}
`

const pageBroken = `export function page(rows, cursor, limit) {
	const start = Number(cursor || 0)
	return { items: rows.slice(start, start + limit), next: String(start + limit) }
}
`

const rulesReference = `export function effectiveRules(layers) {
	const merged = {}
	for (const layer of layers) {
		const { protected: protectedFiles, ...rest } = layer
		Object.assign(merged, rest)
		if (protectedFiles) merged.protected = [...new Set([...(merged.protected ?? []), ...protectedFiles])]
	}
	return merged
}
export function mayEdit(file, rules) {
	return !(rules.protected ?? []).includes(file)
}
`

const rulesAlternative = `export function effectiveRules(layers) {
	const format = layers.at(-1)?.format
	const protectedFiles = layers.flatMap((layer) => layer.protected ?? [])
	return { format, protected: protectedFiles }
}
export function mayEdit(file, rules) {
	return !(rules.protected ?? []).includes(file)
}
`

const rulesBroken = `export function effectiveRules(layers) {
	return { ...layers.at(-1) }
}
export function mayEdit(file, rules) {
	return !(rules.protected ?? []).includes(file)
}
`

const traceReference = `export function validatedAfterLastEdit(events) {
	let lastEdit = -1
	events.forEach((event, index) => {
		if (event.type === "edit") lastEdit = index
	})
	return events.slice(lastEdit + 1).some((event) => event.type === "test" && event.ok)
}
`

const traceAlternative = `export function validatedAfterLastEdit(events) {
	const lastEdit = events.findLastIndex((event) => event.type === "edit")
	return events.slice(lastEdit + 1).some((event) => event.type === "test" && event.ok === true)
}
`

const traceBroken = `export function validatedAfterLastEdit(events) {
	return events.some((event) => event.type === "test" && event.ok)
}
`

const paymentsReference = `export async function charge(store, provider, key, amount) {
	if (store.has(key)) return store.get(key)
	const result = await provider.charge(amount)
	store.set(key, result)
	return result
}
`

const paymentsAlternative = `export async function charge(store, provider, key, amount) {
	const existing = store.get(key)
	if (existing !== undefined) return existing
	const result = await provider.charge(amount)
	if (!store.has(key)) store.set(key, result)
	return store.get(key)
}
`

const paymentsBroken = `export async function charge(store, provider, key, amount) {
	const result = await provider.charge(amount)
	store.set(key, result)
	return result
}
`

const pathsReference = `import path from "node:path"
export function isAllowed(root, candidate) {
	const base = path.resolve(root)
	const target = path.resolve(candidate)
	const relative = path.relative(base, target)
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
`

const pathsAlternative = `import path from "node:path"
export function isAllowed(root, candidate) {
	const base = path.resolve(root)
	const target = path.resolve(candidate)
	if (target === base) return true
	const prefix = base.endsWith(path.sep) ? base : base + path.sep
	return target.startsWith(prefix)
}
`

const pathsBroken = `import path from "node:path"
export function isAllowed(root, candidate) {
	return path.resolve(candidate).startsWith(path.resolve(root))
}
`

export const coreBankControls: readonly ProblemSolvingBankControl[] = [
	{
		id: "repo-cache-invalidation",
		testFile: "test/behavior.test.js",
		target: "src/cache.js",
		reference: cacheReference,
		alternative: cacheAlternative,
		broken: cacheBroken,
	},
	{
		id: "repo-stream-backpressure",
		testFile: "test/behavior.test.js",
		target: "src/pipeline.js",
		reference: pipelineReference,
		alternative: pipelineAlternative,
		broken: pipelineBroken,
	},
	{
		id: "repo-workspace-package-order",
		testFile: "test/behavior.test.js",
		target: "src/workspace.js",
		reference: workspaceReference,
		alternative: workspaceAlternative,
		broken: workspaceBroken,
	},
	{
		id: "repo-cli-config-layering",
		testFile: "test/behavior.test.js",
		target: "src/argv.js",
		reference: argvReference,
		alternative: argvAlternative,
		broken: argvBroken,
	},
	{
		id: "repo-pagination-cursor",
		testFile: "test/behavior.test.js",
		target: "src/page.js",
		reference: pageReference,
		alternative: pageAlternative,
		broken: pageBroken,
	},
	{
		id: "alpha-repository-rules",
		testFile: "test/behavior.test.js",
		target: "src/rules.js",
		reference: rulesReference,
		alternative: rulesAlternative,
		broken: rulesBroken,
	},
	{
		id: "alpha-validation-after-edit",
		testFile: "test/behavior.test.js",
		target: "src/trace.js",
		reference: traceReference,
		alternative: traceAlternative,
		broken: traceBroken,
	},
	{
		id: "stateful-api-idempotency",
		testFile: "test/behavior.test.js",
		target: "src/payments.js",
		reference: paymentsReference,
		alternative: paymentsAlternative,
		broken: paymentsBroken,
	},
	{
		id: "safety-path-policy",
		testFile: "test/behavior.test.js",
		target: "src/paths.js",
		reference: pathsReference,
		alternative: pathsAlternative,
		broken: pathsBroken,
	},
]
