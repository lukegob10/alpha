import * as path from "path"
import * as os from "os"
import { randomUUID } from "node:crypto"
import * as vscode from "vscode"
import { getWorkspacePath } from "../../utils/path"
import { t } from "../../i18n"

export async function openImage(dataUriOrPath: string, options?: { values?: { action?: string } }) {
	// Check if it's a file path (absolute or relative)
	const isFilePath =
		!dataUriOrPath.startsWith("data:") &&
		!dataUriOrPath.startsWith("http:") &&
		!dataUriOrPath.startsWith("https:") &&
		!dataUriOrPath.startsWith("vscode-resource:") &&
		!dataUriOrPath.startsWith("file+.vscode-resource")

	if (isFilePath) {
		// Handle file path - open directly in VSCode
		try {
			// Resolve the path relative to workspace if needed
			let filePath = dataUriOrPath
			if (!path.isAbsolute(filePath)) {
				const workspacePath = getWorkspacePath()
				if (workspacePath) {
					filePath = path.join(workspacePath, filePath)
				}
			}

			const fileUri = vscode.Uri.file(filePath)

			// Check if this is a copy action
			if (options?.values?.action === "copy") {
				await vscode.env.clipboard.writeText(filePath)
				vscode.window.showInformationMessage(t("common:info.path_copied_to_clipboard"))
				return
			}

			// Open the image file directly
			await vscode.commands.executeCommand("vscode.open", fileUri)
		} catch (error) {
			vscode.window.showErrorMessage(t("common:errors.error_opening_image", { error }))
		}
		return
	}

	const matches = dataUriOrPath.match(/^data:image\/([a-zA-Z]+|svg\+xml);base64,(.+)$/)
	if (!matches) {
		vscode.window.showErrorMessage(t("common:errors.invalid_data_uri"))
		return
	}
	const [, format, base64Data] = matches
	const imageBuffer = Buffer.from(base64Data, "base64")

	if (options?.values?.action === "copy") {
		try {
			await vscode.env.clipboard.writeText(`data:image/${format};base64,${imageBuffer.toString("base64")}`)
			vscode.window.showInformationMessage(t("common:info.image_copied_to_clipboard"))
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error)
			vscode.window.showErrorMessage(t("common:errors.error_copying_image", { errorMessage }))
		}
		return
	}

	const extension = format === "svg+xml" ? "svg" : format
	const tempFileUri = vscode.Uri.file(path.join(os.tmpdir(), `temp_image_${randomUUID()}.${extension}`))
	try {
		await vscode.workspace.fs.writeFile(tempFileUri, imageBuffer)
		if (format === "svg+xml") {
			await vscode.commands.executeCommand("vscode.openWith", tempFileUri, "imagePreview.previewEditor")
		} else {
			await vscode.commands.executeCommand("vscode.open", tempFileUri)
		}
	} catch (error) {
		try {
			await vscode.workspace.fs.delete(tempFileUri)
		} catch {
			// The file may never have been created. Report the original error.
		}
		vscode.window.showErrorMessage(t("common:errors.error_opening_image", { error }))
	}
}

export async function saveImage(dataUri: string, defaultUri: vscode.Uri): Promise<vscode.Uri | undefined> {
	const matches = dataUri.match(/^data:image\/([a-zA-Z]+);base64,(.+)$/)
	if (!matches) {
		vscode.window.showErrorMessage(t("common:errors.invalid_data_uri"))
		return undefined
	}
	const [, format, base64Data] = matches
	const imageBuffer = Buffer.from(base64Data, "base64")

	// Show save dialog
	const saveUri = await vscode.window.showSaveDialog({
		filters: {
			Images: [format],
			"All Files": ["*"],
		},
		defaultUri: defaultUri,
	})

	if (!saveUri) {
		// User cancelled the save dialog
		return undefined
	}

	try {
		// Write the image to the selected location
		await vscode.workspace.fs.writeFile(saveUri, imageBuffer)
		vscode.window.showInformationMessage(t("common:info.image_saved", { path: saveUri.fsPath }))
		return saveUri
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error)
		vscode.window.showErrorMessage(t("common:errors.error_saving_image", { errorMessage }))
		return undefined
	}
}
