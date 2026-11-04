export interface TextResult {
  readonly [key: string]: unknown;
  readonly content: [{ type: "text"; text: string }];
  readonly structuredContent?: Readonly<Record<string, unknown>>;
}

/** An MCP tool result: the value as JSON text, and as structured content when it is an object. */
export function result(value: unknown): TextResult {
  const textResult: TextResult = {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }]
  };
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return {
      ...textResult,
      structuredContent: value as Readonly<Record<string, unknown>>
    };
  }
  return textResult;
}
