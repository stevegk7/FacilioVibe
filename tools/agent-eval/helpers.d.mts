// Types for the plain-ESM eval helpers, so the mirror test in
// src/__tests__/agents-eval-helpers.test.ts typechecks with the rest of src.
export function contentOf(res: unknown): string;
export function stripFences(text: string): string;
export function orNone(value: unknown): string | undefined;
export function parseTool(reply: string): { tool: string; args: Record<string, unknown> } | null;
export function num(value: unknown): number | undefined;
export function parseRunEnvelope(stdout: string): {
  status?: string;
  response?: { content?: unknown };
};
