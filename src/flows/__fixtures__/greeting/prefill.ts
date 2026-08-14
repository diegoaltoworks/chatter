import type { FlowPrefill } from "../../types";

export const prefillFromContext: FlowPrefill = (_sessionKey, context) => {
  return { ...context };
};
