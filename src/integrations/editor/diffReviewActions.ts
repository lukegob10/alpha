import * as vscode from "vscode"
import { t } from "../../i18n"

// Native multi-diff actions verified in the 1.125.0 and 1.141.0 hosts (2026-11-03).
export async function showDiffReviewActions(): Promise<void> {
	const tab = vscode.window.tabGroups.activeTabGroup.activeTab
	if (!tab) return
	const commands = await vscode.commands.getCommands(true)
	if (vscode.window.tabGroups.activeTabGroup.activeTab !== tab) return
	const actions = [
		{ label: t("common:diffReview.collapseAll"), command: "multiDiffEditor.collapseAll" },
		{ label: t("common:diffReview.expandAll"), command: "multiDiffEditor.expandAll" },
		{ label: t("common:diffReview.nextChange"), command: "multiDiffEditor.goToNextChange" },
		{ label: t("common:diffReview.previousChange"), command: "multiDiffEditor.goToPreviousChange" },
	]
	// Layout selections use the native view preference, only after the user chooses one.
	// The explicit modes are newer than the minimum host; retain its native layout toggle.
	if (commands.includes("diffEditor.setViewMode.sideBySide") && commands.includes("diffEditor.setViewMode.inline")) {
		actions.push(
			{ label: t("common:diffReview.sideBySide"), command: "diffEditor.setViewMode.sideBySide" },
			{ label: t("common:diffReview.inline"), command: "diffEditor.setViewMode.inline" },
		)
	} else {
		actions.push({ label: t("common:diffReview.toggleLayout"), command: "toggle.diff.renderSideBySide" })
	}
	const selected = await vscode.window.showQuickPick(actions, { title: t("common:diffReview.title") })
	// Quick Input can outlive its editor. Never send a delayed action to another review.
	if (selected && vscode.window.tabGroups.activeTabGroup.activeTab === tab) {
		await vscode.commands.executeCommand(selected.command)
	}
}
