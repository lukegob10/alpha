import i18next from "i18next"
import common from "./locales/en/common.json"
import embeddings from "./locales/en/embeddings.json"
import htmlArtifactKit from "./locales/en/htmlArtifactKit.json"
import htmlDocument from "./locales/en/htmlDocument.json"
import marketplace from "./locales/en/marketplace.json"
import mcp from "./locales/en/mcp.json"
import scheduledTasks from "./locales/en/scheduledTasks.json"
import skills from "./locales/en/skills.json"
import tools from "./locales/en/tools.json"
import worktrees from "./locales/en/worktrees.json"

// Initialize i18next with configuration
i18next.init({
	lng: "en",
	fallbackLng: "en",
	debug: false,
	// Unit tests use translation keys; production bundles English resources without extension-host file I/O.
	resources:
		process.env.NODE_ENV === "test"
			? {}
			: {
					en: {
						common,
						embeddings,
						htmlArtifactKit,
						htmlDocument,
						marketplace,
						mcp,
						scheduledTasks,
						skills,
						tools,
						worktrees,
					},
				},
	interpolation: {
		escapeValue: false,
	},
})

export default i18next
