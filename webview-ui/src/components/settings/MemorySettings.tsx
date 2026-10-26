import { useState } from "react"
import { DEFAULT_MEMORY_SETTINGS, type MemorySettings as MemorySettingsConfig } from "@alpha-code/types"

import { useAppTranslation } from "@/i18n/TranslationContext"
import { vscode } from "@/utils/vscode"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
	Button,
	Checkbox,
} from "@/components/ui"

import { Section } from "./Section"
import { SectionHeader } from "./SectionHeader"
import { SearchableSetting } from "./SearchableSetting"

type MemorySettingsProps = {
	memorySettings?: MemorySettingsConfig
	onChange: (settings: MemorySettingsConfig) => void
}

const booleanSettings = ["enabled", "useMemories", "generateMemories"] as const

export function MemorySettings({ memorySettings, onChange }: MemorySettingsProps) {
	const { t } = useAppTranslation()
	const settings = memorySettings ?? DEFAULT_MEMORY_SETTINGS
	const [confirmReset, setConfirmReset] = useState(false)

	return (
		<div className="flex flex-col gap-2">
			<SectionHeader description={t("settings:memory.description")}>{t("settings:memory.title")}</SectionHeader>
			<Section>
				{booleanSettings.map((key) => (
					<SearchableSetting
						key={key}
						settingId={`memory-${key}`}
						section="contextManagement"
						label={t(`settings:memory.${key}.label`)}>
						<div className="flex items-center gap-2">
							<Checkbox
								id={`memory-${key}`}
								checked={settings[key]}
								disabled={key !== "enabled" && !settings.enabled}
								aria-describedby={`memory-${key}-description`}
								onCheckedChange={(checked) => onChange({ ...settings, [key]: checked === true })}
							/>
							<label htmlFor={`memory-${key}`} className="font-medium">
								{t(`settings:memory.${key}.label`)}
							</label>
						</div>
						<p
							id={`memory-${key}-description`}
							className="mt-1 mb-0 text-sm text-vscode-descriptionForeground">
							{t(`settings:memory.${key}.description`)}
						</p>
					</SearchableSetting>
				))}

				<div className="flex flex-wrap gap-2">
					<Button variant="secondary" onClick={() => vscode.postMessage({ type: "memoryOpenFolder" })}>
						{t("settings:memory.openFolder")}
					</Button>
					<Button variant="secondary" onClick={() => setConfirmReset(true)}>
						{t("settings:memory.reset")}
					</Button>
				</div>
			</Section>

			<AlertDialog open={confirmReset} onOpenChange={setConfirmReset}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>{t("settings:memory.resetTitle")}</AlertDialogTitle>
						<AlertDialogDescription>{t("settings:memory.resetDescription")}</AlertDialogDescription>
					</AlertDialogHeader>
					<AlertDialogFooter>
						<AlertDialogCancel>{t("settings:memory.cancel")}</AlertDialogCancel>
						<AlertDialogAction onClick={() => vscode.postMessage({ type: "memoryReset" })}>
							{t("settings:memory.confirmReset")}
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}
