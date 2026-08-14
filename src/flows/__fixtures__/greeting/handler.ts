import type { FlowHandler } from "../../types";

export const execute: FlowHandler = async (params) => {
  return {
    success: true,
    message: `Hello, ${params.name}!`,
    result: { name: params.name },
  };
};
