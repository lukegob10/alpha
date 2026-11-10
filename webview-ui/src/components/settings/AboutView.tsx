import { ArrowLeft } from "lucide-react"

import { Button } from "@/components/ui"
import { useAppTranslation } from "@/i18n/TranslationContext"

import { Tab, TabContent, TabHeader } from "../common/Tab"
import { About } from "./About"

const AboutView = ({ onDone }: { onDone: () => void }) => {
	const { t } = useAppTranslation()

	return (
		<Tab data-testid="about-view">
			<TabHeader>
				<Button variant="ghost" size="sm" onClick={onDone}>
					<ArrowLeft className="size-4" aria-hidden="true" />
					{t("settings:back")}
				</Button>
			</TabHeader>
			<TabContent className="p-0">
				<About />
			</TabContent>
		</Tab>
	)
}

export default AboutView
