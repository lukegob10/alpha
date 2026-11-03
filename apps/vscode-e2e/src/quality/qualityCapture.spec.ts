import { test } from "node:test"
import * as assert from "node:assert/strict"
import * as path from "node:path"

import { readQualityCaptureOptions } from "../runQuality"

const args = [
	"capture",
	"--label",
	"baseline",
	"--provider",
	"live",
	"--saved-provider",
	"anthropic",
	"--model-id",
	"chosen",
	"--effort",
	"high",
	"--profile-dir",
	path.resolve("profile"),
	"--output",
	path.resolve("output"),
]

test("quality capture selects an arbitrary declared saved provider and external extension build", () => {
	const extension = path.resolve("baseline", "src")
	assert.deepEqual(readQualityCaptureOptions([...args, "--extension-development-path", extension]), {
		label: "baseline",
		provider: "live",
		savedProvider: "anthropic",
		modelId: "chosen",
		effort: "high",
		profileDir: path.resolve("profile"),
		output: path.resolve("output"),
		samples: 3,
		extensionDevelopmentPath: extension,
	})
})

test("quality capture refuses scripted routes, ambiguous selection, single samples and accidental output reuse options", () => {
	for (const extra of [
		["--samples", "1"],
		["--provider", "scripted"],
		["--model-id", "other"],
		["--extension-development-path", "relative"],
		["--unknown", "x"],
	])
		assert.throws(() => readQualityCaptureOptions([...args, ...extra]))
	assert.throws(() => readQualityCaptureOptions(args.filter((_value, index) => ![5, 6].includes(index))))
})
