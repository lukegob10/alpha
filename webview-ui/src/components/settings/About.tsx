import { HTMLAttributes } from "react"
import { useAppTranslation } from "@/i18n/TranslationContext"
import { Download, Upload, TriangleAlert } from "lucide-react"

import { Package } from "@alpha/package"

import { vscode } from "@/utils/vscode"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui"

import { SectionHeader } from "./SectionHeader"
import { Section } from "./Section"
import { SearchableSetting } from "./SearchableSetting"

type AboutProps = HTMLAttributes<HTMLDivElement> & {
	embedded?: boolean
}

export const About = ({ embedded = false, className, ...props }: AboutProps) => {
	const { t } = useAppTranslation()
	const version = Package.sha ? `${Package.version} (${Package.sha.slice(0, 8)})` : Package.version

	return (
		<div className={cn("flex flex-col gap-2", className)} {...props}>
			{!embedded && (
				<SectionHeader description={t("settings:about.description")}>
					{t("settings:sections.about")}
				</SectionHeader>
			)}

			<Section>
				<p className="m-0">{t("settings:about.version", { version })}</p>
			</Section>

			<Section className="space-y-0">
				<SearchableSetting
					settingId="about-manage-settings"
					section="about"
					label={t("settings:about.manageSettings")}>
					<h3>{t("settings:about.manageSettings")}</h3>
					<p className="text-vscode-descriptionForeground text-sm">
						{t("settings:about.manageSettingsDescription")}
					</p>
					<div className="flex flex-wrap items-center gap-2">
						<Button onClick={() => vscode.postMessage({ type: "exportSettings" })} className="w-28">
							<Upload className="p-0.5" />
							{t("settings:footer.settings.export")}
						</Button>
						<Button onClick={() => vscode.postMessage({ type: "importSettings" })} className="w-28">
							<Download className="p-0.5" />
							{t("settings:footer.settings.import")}
						</Button>
						<Button
							variant="destructive"
							onClick={() => vscode.postMessage({ type: "resetState" })}
							className="w-28">
							<TriangleAlert className="p-0.5" />
							{t("settings:footer.settings.reset")}
						</Button>
					</div>
				</SearchableSetting>
			</Section>
		</div>
	)
}
