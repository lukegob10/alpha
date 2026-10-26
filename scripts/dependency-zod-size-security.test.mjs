import assert from "node:assert/strict"
import { createRequire } from "node:module"
import path from "node:path"
import { test } from "node:test"
import { pathToFileURL, URL } from "node:url"

const extensionRequire = createRequire(new URL("../src/package.json", import.meta.url))
const packageRoot =
	process.env.ALPHA_TEST_ZOD_PACKAGE_ROOT ?? path.dirname(extensionRequire.resolve("zod/package.json"))
const packageRequire = createRequire(path.join(packageRoot, "package.json"))

// Backport of the upper-size gates in colinhacks/zod@a0ebf970f2d752e5f58527cd2942ff48be4f46bd
// for GHSA-mrhx-c7xc-m3w5. Unbounded collections retain their existing issue reporting.
const variants = []
for (const dialect of ["cjs", "js"]) {
	for (const version of [3, 4]) {
		const entry = path.join(packageRoot, version === 3 ? "v3" : "v4", `index.${dialect}`)
		const { z } = dialect === "cjs" ? packageRequire(entry) : await import(pathToFileURL(entry).href)
		variants.push({ name: `v${version} ${dialect === "cjs" ? "CommonJS" : "ESM"}`, version, z })
	}
}

function collectionCases(z, version) {
	const cases = [
		{ name: "array max", schema: (item) => z.array(item).max(2, "size cap"), input: ["A", "B", "C"] },
		{ name: "array length", schema: (item) => z.array(item).length(2, "size cap"), input: ["A", "B", "C"] },
		{ name: "set max", schema: (item) => z.set(item).max(2, "size cap"), input: new Set(["A", "B", "C"]) },
		{ name: "set size", schema: (item) => z.set(item).size(2, "size cap"), input: new Set(["A", "B", "C"]) },
	]
	if (version === 4) {
		for (const [name, check] of [
			["map max", () => z.maxSize(2, { message: "size cap" })],
			["map size", () => z.size(2, { message: "size cap" })],
		]) {
			cases.push({
				name,
				schema: (item) => z.map(item, item).check(check()),
				input: new Map([
					["A", "a"],
					["B", "b"],
					["C", "c"],
				]),
			})
		}
	}
	return cases
}

for (const { name, version, z } of variants) {
	test(`${name} rejects oversized collections before synchronous element and collection refinements`, () => {
		for (const fixture of collectionCases(z, version)) {
			let elements = 0
			let refinements = 0
			const schema = fixture.schema(z.string().refine(() => ++elements > 0)).refine(() => ++refinements > 0)
			const result = z.object({ items: schema }).safeParse({ items: fixture.input })
			assert.equal(result.success, false, fixture.name)
			assert.deepEqual(
				result.error.issues.map(({ code, path, message }) => ({ code, path, message })),
				[{ code: "too_big", path: ["items"], message: "size cap" }],
			)
			assert.deepEqual([elements, refinements], [0, 0], fixture.name)
		}
	})

	test(`${name} rejects oversized collections before asynchronous element and collection refinements`, async () => {
		for (const fixture of collectionCases(z, version)) {
			let elements = 0
			let refinements = 0
			const schema = fixture
				.schema(z.string().refine(async () => ++elements > 0))
				.refine(async () => ++refinements > 0)
			const result = await schema.safeParseAsync(fixture.input)
			assert.equal(result.success, false, fixture.name)
			assert.equal(result.error.issues.length, 1, fixture.name)
			assert.equal(result.error.issues[0].code, "too_big", fixture.name)
			assert.deepEqual([elements, refinements], [0, 0], fixture.name)
		}
	})

	test(`${name} bounds issue accumulation without truncating ordinary validation errors`, () => {
		const input = Array(128).fill(0)
		for (const schema of [z.array(z.string()).max(2), z.array(z.string()).length(2)]) {
			const result = schema.safeParse(input)
			assert.equal(result.success, false)
			assert.equal(result.error.issues.length, 1)
			assert.equal(result.error.issues[0].code, "too_big")
		}
		assert.equal(z.array(z.string()).safeParse(input).error.issues.length, input.length)
		assert.equal(z.array(z.string()).max(2).safeParse([0, 1]).error.issues.length, 2)
		assert.equal(z.array(z.string()).length(3).safeParse([0, 1]).error.issues.length, 3)
		assert.equal(
			z
				.set(z.string())
				.size(3)
				.safeParse(new Set([0, 1])).error.issues.length,
			3,
		)
	})

	test(`${name} preserves valid transforms, lower bounds, type errors and preprocessing`, async () => {
		const strings = z.string().transform((value) => value.toLowerCase())
		const array = z.array(strings).min(1).max(2)
		assert.deepEqual(array.parse(["A", "B"]), ["a", "b"])
		assert.deepEqual(await array.parseAsync(["A"]), ["a"])
		assert.deepEqual(
			z
				.set(strings)
				.size(2)
				.parse(new Set(["A", "B"])),
			new Set(["a", "b"]),
		)
		assert.deepEqual(
			z
				.set(strings)
				.max(2)
				.parse(new Set(["A", "a"])),
			new Set(["a"]),
		)
		assert.equal(array.safeParse([]).error.issues[0].code, "too_small")
		assert.equal(array.safeParse({ length: 3 }).error.issues[0].code, "invalid_type")
		assert.equal(z.set(strings).max(2).safeParse(new Map()).error.issues[0].code, "invalid_type")
		assert.deepEqual(z.preprocess((value) => value.slice(0, 2), array).parse(["A", "B", "C"]), ["a", "b"])
		assert.equal(array.transform((value) => value.join(",")).parse(["A", "B"]), "a,b")
		assert.deepEqual(z.array(z.string()).max(0).parse([]), [])
		assert.deepEqual(z.set(z.string()).max(0).parse(new Set()), new Set())
		assert.equal(z.array(z.string()).max(0).safeParse(["A"]).error.issues[0].code, "too_big")
		assert.equal(
			z
				.set(z.string())
				.max(0)
				.safeParse(new Set(["A"])).error.issues[0].code,
			"too_big",
		)
	})

	if (version === 4) {
		test(`${name} preserves checks that may rewrite the collection before its bound`, () => {
			const input = ["A", "B", "C"]
			assert.deepEqual(
				z
					.array(z.string())
					.overwrite((value) => value.slice(0, 2))
					.max(2)
					.parse(input),
				["A", "B"],
			)
			assert.equal(
				z
					.array(z.string())
					.max(2)
					.overwrite((value) => value.slice(0, 2))
					.safeParse(input).success,
				false,
			)
			let elements = 0
			const afterRefinement = z
				.array(z.string().refine(() => ++elements > 0))
				.refine(() => true)
				.max(2)
			assert.equal(afterRefinement.safeParse(input).success, false)
			assert.equal(elements, input.length)
			const stricter = z.array(z.string()).check(z.maxLength(2), z.maxLength(1))
			assert.equal(stricter.safeParse(["A", "B"]).error.issues.length, 1)
		})

		test(`${name} applies the upstream raw upper-size bound before set and map transforms deduplicate entries`, () => {
			let transformed = 0
			const strings = z.string().transform((value) => {
				transformed++
				return value.toLowerCase()
			})
			assert.equal(
				z
					.set(strings)
					.max(1)
					.safeParse(new Set(["A", "a"])).success,
				false,
			)
			assert.equal(
				z
					.map(strings, strings)
					.check(z.maxSize(1))
					.safeParse(
						new Map([
							["A", "x"],
							["a", "y"],
						]),
					).success,
				false,
			)
			assert.equal(transformed, 0)
			assert.deepEqual(
				z
					.map(strings, strings)
					.check(z.maxSize(2))
					.parse(
						new Map([
							["A", "X"],
							["a", "Y"],
						]),
					),
				new Map([["a", "y"]]),
			)
		})
	}
}

test("the package root and v3 alias share the same parser in CommonJS and ESM", async () => {
	assert.equal(packageRequire(path.join(packageRoot, "index.cjs")).z, variants[0].z)
	assert.equal((await import(pathToFileURL(path.join(packageRoot, "index.js")).href)).z, variants[2].z)
})

for (const dialect of ["cjs", "js"]) {
	test(`v4 Mini ${dialect} shares the core size gate`, async () => {
		const entry = path.join(packageRoot, "v4", "mini", `index.${dialect}`)
		const z = dialect === "cjs" ? packageRequire(entry) : await import(pathToFileURL(entry).href)
		let parsed = 0
		const item = z.string().check(z.refine(() => ++parsed > 0))
		for (const [schema, input] of [
			[z.array(item).check(z.maxLength(1)), ["A", "B"]],
			[z.set(item).check(z.maxSize(1)), new Set(["A", "B"])],
			[
				z.map(item, item).check(z.maxSize(1)),
				new Map([
					["A", "a"],
					["B", "b"],
				]),
			],
		]) {
			const result = z.safeParse(schema, input)
			assert.equal(result.success, false)
			assert.equal(result.error.issues.length, 1)
		}
		assert.equal(parsed, 0)
	})
}
