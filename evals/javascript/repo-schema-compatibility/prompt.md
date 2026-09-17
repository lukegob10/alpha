A rolling deployment writes only the new displayName field, breaking old readers that require firstName and lastName. Encode both shapes during the compatibility window and decode either shape.

Do not edit tests. Preserve the exported API and run the declared validation command after the final edit.
