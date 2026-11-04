import type { CommandId } from "@alpha-code/types"

import { Package } from "../shared/package"

export const getCommand = (id: CommandId) => `${Package.name}.${id}`
