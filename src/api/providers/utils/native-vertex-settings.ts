import { hasCustomVertexConnection } from "@alpha-code/types"
import { t } from "../../../i18n"

/** Preserve saved route intent: removing a gateway must never silently dispatch to Google instead. */
export function assertNativeVertexSettings(options: object): void {
	if (hasCustomVertexConnection(options)) throw new Error(t("embeddings:serviceFactory.vertexGatewayRemoved"))
}
