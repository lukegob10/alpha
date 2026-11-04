import { memo } from "react"
import { useTranslation } from "react-i18next"
import { openFileDiffs } from "@src/utils/openDiff"
import CodeAccordion from "../common/CodeAccordion"

interface FileDiff {
	path: string
	changeCount: number
	key: string
	content: string
	originalContent?: string
	finalContent?: string
	diffStats?: { added: number; removed: number }
	diffs?: Array<{
		content: string
		startLine?: number
	}>
}

interface BatchDiffApprovalProps {
	files: FileDiff[]
	ts: number
}

export const BatchDiffApproval = memo(({ files = [], ts }: BatchDiffApprovalProps) => {
	const { t } = useTranslation()

	if (!files?.length) {
		return null
	}

	return (
		<div className="pt-[5px]">
			<div className="flex flex-col gap-0 border border-border rounded-md p-1">
				{files.map((file, index) => {
					// Use backend-provided unified diff only. Stats also provided by backend.
					const unified = file.content || ""

					return (
						<div key={`${file.path}-${index}-${ts}`}>
							<CodeAccordion
								path={file.path}
								code={unified}
								language="diff"
								onOpenDiff={() =>
									openFileDiffs(
										[{ ...file, diff: unified }],
										t("chat:fileChangesInConversation.diffTitleForFile", { path: file.path }),
										t("chat:fileChangesInConversation.diffTitle"),
									)
								}
								diffStats={file.diffStats ?? undefined}
							/>
						</div>
					)
				})}
			</div>
		</div>
	)
})

BatchDiffApproval.displayName = "BatchDiffApproval"
