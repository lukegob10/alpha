import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { Tab, TabHeader } from "../common/Tab"
import { WorktreesView } from "./WorktreesView"

const WorktreesManagerView = ({ onDone }: { onDone: () => void }) => {
	const { t } = useAppTranslation()

	return (
		<Tab data-testid="worktrees-manager-view">
			<TabHeader>
				<Button variant="ghost" size="sm" onClick={onDone}>
					<ArrowLeft className="size-4" aria-hidden="true" />
					{t("settings:back")}
				</Button>
			</TabHeader>
			<div className="min-h-0 flex-1">
				<WorktreesView />
			</div>
		</Tab>
	)
}

export default WorktreesManagerView
