import path from "path"
import { describe, expect, it } from "vitest"

import { extractApplyPatchCommand, rebaseApplyPatchPaths } from "../invocation"

const patch = "*** Begin Patch\n*** Add File: note.txt\n+hello\n*** End Patch"

describe("Codex-style apply_patch command invocation", () => {
	it.each([
		[`apply_patch <<'PATCH'\n${patch}\nPATCH`, undefined],
		[`apply_patch <<PATCH\n${patch}\nPATCH`, undefined],
		[`applypatch <<\"PATCH\"\r\n${patch.replaceAll("\n", "\r\n")}\r\nPATCH\r\n`, undefined],
		[`cd src && apply_patch <<'PATCH'\n${patch}\nPATCH`, "src"],
		[`cd 'my folder' && apply_patch <<'PATCH'\n${patch}\nPATCH`, "my folder"],
	])("extracts a complete standalone heredoc", (command, workdir) => {
		expect(extractApplyPatchCommand(command)).toEqual({ kind: "patch", patch, ...(workdir ? { workdir } : {}) })
	})

	it.each([
		`echo ready && apply_patch <<'PATCH'\n${patch}\nPATCH`,
		`apply_patch <<'PATCH'\n${patch}\nPATCH\necho done`,
		"apply_patch --version",
		`apply_patch @'\n${patch}\n'@`,
	])("leaves other shell commands alone", (command) => {
		expect(extractApplyPatchCommand(command)).toBeUndefined()
	})

	it("returns a tool error for a recognized but unterminated heredoc", () => {
		expect(extractApplyPatchCommand(`apply_patch <<'PATCH'\n${patch}\nWRONG`)).toEqual({
			kind: "error",
			message: "apply_patch heredoc must end with PATCH.",
		})
	})

	it("rebases update, move, and add paths from the command directory to the task root", () => {
		const root = path.join(path.sep, "workspace")
		const input = "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch"
		expect(rebaseApplyPatchPaths(input, root, path.join(root, "src"))).toBe(
			input.replace("old.txt", "src/old.txt").replace("new.txt", "src/new.txt"),
		)
		expect(rebaseApplyPatchPaths(patch, root, root)).toBe(patch)
	})
})
