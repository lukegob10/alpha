import * as vscode from "vscode"
import * as path from "path"
import { readFile } from "fs/promises"
import { validateSkillName } from "@alpha-code/types"

const SCHEME = "alpha-builtin-skill"

export function builtinSkillInspectionUri(name: string): vscode.Uri {
	return vscode.Uri.from({ scheme: SCHEME, path: `/${name}/SKILL.md` })
}

/** Virtual documents are read-only; inspecting a skill never exposes an editable bundled file. */
export function registerBuiltinSkillInspection(extensionUri: vscode.Uri): vscode.Disposable {
	return vscode.workspace.registerTextDocumentContentProvider(SCHEME, {
		async provideTextDocumentContent(uri) {
			const match = /^\/([^/]+)\/SKILL\.md$/.exec(uri.path)
			if (!match || !validateSkillName(match[1]).valid || uri.authority || uri.query || uri.fragment) {
				throw new Error("Invalid built-in skill reference")
			}
			return readFile(path.join(extensionUri.fsPath, "assets", "skills", match[1], "SKILL.md"), "utf8")
		},
	})
}
