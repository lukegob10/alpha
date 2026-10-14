import { parametersSchema, defineCustomTool } from "@alpha-code/types"

export default defineCustomTool({
	name: "cached",
	description: "Cached tool",
	parameters: parametersSchema.object({}),
	async execute() {
		return "cached"
	},
})
