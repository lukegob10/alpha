const assert = require("node:assert/strict")
const { spawnSync } = require("node:child_process")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const test = require("node:test")

const {
	ALLOWED_EDITORS,
	NIGHTLY_REMOVAL_MESSAGE,
	createEditorInvocation,
	normalizeEditor,
	parseArguments,
	quoteWindowsArgument,
	runEditor,
	validatePackageMetadata,
} = require("./install-vsix.js")

const installerPath = path.join(__dirname, "install-vsix.js")
const repositoryRoot = path.join(__dirname, "..")

test("accepts only the supported editor names", () => {
	assert.deepEqual(ALLOWED_EDITORS, ["code", "code-insiders", "cursor"])
	for (const editor of ALLOWED_EDITORS) {
		assert.equal(normalizeEditor(editor), editor)
	}
	assert.equal(normalizeEditor("CODE", { platform: "win32" }), "code")
	assert.equal(normalizeEditor("code.cmd", { platform: "win32" }), "code")

	for (const editor of ["code && whoami", "code; whoami", "C:\\Tools\\code.cmd", "--install-extension"]) {
		assert.throws(() => normalizeEditor(editor), /Editor must be one of/)
	}
	assert.throws(() => normalizeEditor("code.cmd", { platform: "linux" }), /Editor must be one of/)
})

test("parses supported flags and rejects the retired nightly path", () => {
	assert.deepEqual(parseArguments(["-y", "--editor=cursor"]), { autoYes: true, editor: "cursor" })
	assert.deepEqual(parseArguments(["--editor", "code-insiders"]), { autoYes: false, editor: "code-insiders" })
	assert.throws(() => parseArguments(["--nightly"]), new RegExp(NIGHTLY_REMOVAL_MESSAGE))
	assert.throws(() => parseArguments(["--editor=code", "--editor=cursor"]), /only be provided once/)
})

test("accepts only safe manifest-derived package metadata", () => {
	assert.deepEqual(validatePackageMetadata({ name: "alpha", version: "2.1.45", publisher: "AlphaInc" }), {
		name: "alpha",
		version: "2.1.45",
		publisher: "AlphaInc",
	})

	for (const metadata of [
		{ name: "alpha&beta", version: "2.1.45", publisher: "AlphaInc" },
		{ name: "alpha", version: "2.1.45+build!", publisher: "AlphaInc" },
		{ name: "alpha", version: "2.1.45", publisher: "Alpha%Inc" },
	]) {
		assert.throws(() => validatePackageMetadata(metadata), /safe package identifier syntax/u)
	}
})

test("passes Unix editor arguments without shell interpolation", () => {
	const calls = []
	runEditor("cursor", ["--install-extension", "/tmp/workspace with spaces/alpha&beta.vsix"], {
		platform: "linux",
		execFileSyncImpl: (...args) => calls.push(args),
	})

	assert.deepEqual(calls, [
		["cursor", ["--install-extension", "/tmp/workspace with spaces/alpha&beta.vsix"], { stdio: "inherit" }],
	])
})

test("builds a safe Windows .cmd invocation", () => {
	const invocation = createEditorInvocation(
		"code",
		["--install-extension", "C:\\workspace with spaces\\alpha-beta.vsix"],
		{ platform: "win32", comSpec: "C:\\Windows\\System32\\cmd.exe" },
	)

	assert.equal(invocation.file, "C:\\Windows\\System32\\cmd.exe")
	assert.deepEqual(invocation.args.slice(0, 3), ["/d", "/v:off", "/c"])
	assert.deepEqual(invocation.options, { stdio: "inherit", windowsVerbatimArguments: true })
	assert.match(invocation.args[3], /^code\.cmd /u)
	assert.match(invocation.args[3], /alpha-beta/u)
})

test("quotes Windows data arguments and rejects command syntax delimiters", () => {
	assert.equal(
		quoteWindowsArgument("C:\\workspace with spaces\\alpha-beta.vsix"),
		'"C:\\workspace with spaces\\alpha-beta.vsix"',
	)
	for (const value of ['bad"value', "bad\nvalue", "bad\0value", "bad&value", "bad^value", "bad%PATH%", "bad!value"]) {
		assert.throws(() => quoteWindowsArgument(value), /shell metacharacters/u)
	}
})

test(
	"forwards safe Windows .cmd arguments through a real child process",
	{ skip: process.platform !== "win32" },
	() => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-installer-test-"))
		const payload = "workspace path with spaces\\alpha-beta.vsix"
		const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "Path"

		try {
			fs.writeFileSync(
				path.join(root, "code.cmd"),
				[
					"@echo off",
					"setlocal DisableDelayedExpansion",
					"call :capture %*",
					"exit /b",
					":capture",
					'>"%~dp0args.txt" echo(%~1',
					'>>"%~dp0args.txt" echo(%~2',
				].join("\r\n") + "\r\n",
				"ascii",
			)

			const invocation = createEditorInvocation("code", ["--install-extension", payload], {
				platform: "win32",
				comSpec: process.env.ComSpec || "cmd.exe",
			})
			const result = spawnSync(invocation.file, invocation.args, {
				cwd: root,
				env: { ...process.env, [pathKey]: `${root};${process.env[pathKey] || ""}` },
				encoding: "utf8",
				stdio: "pipe",
				windowsVerbatimArguments: invocation.options.windowsVerbatimArguments,
			})

			assert.equal(result.status, 0, result.error?.message || result.stderr)
			assert.deepEqual(fs.readFileSync(path.join(root, "args.txt"), "utf8").trim().split(/\r?\n/u), [
				"--install-extension",
				payload,
			])
		} finally {
			fs.rmSync(root, { recursive: true, force: true })
		}
	},
)

test("rejects nightly installation before reading or invoking an editor", () => {
	const result = spawnSync(process.execPath, [installerPath, "--nightly"], {
		cwd: repositoryRoot,
		encoding: "utf8",
	})

	assert.equal(result.status, 1)
	assert.match(`${result.stdout}\n${result.stderr}`, /Nightly VSIX installation is no longer supported/u)
})

test("rejects shell text supplied as an editor option", () => {
	const isolatedRoot = fs.mkdtempSync(path.join(os.tmpdir(), "alpha-installer-invalid-editor-"))
	try {
		const result = spawnSync(process.execPath, [installerPath, "--editor=code;whoami"], {
			cwd: isolatedRoot,
			encoding: "utf8",
		})

		assert.equal(result.status, 1)
		assert.match(`${result.stdout}\n${result.stderr}`, /Editor must be one of/u)
	} finally {
		fs.rmSync(isolatedRoot, { recursive: true, force: true })
	}
})
