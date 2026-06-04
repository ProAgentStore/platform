/** Workers AI client — server-side inference with any model. */
export interface AiClient {
  run(model: string, input: Record<string, unknown>): Promise<unknown>;
  embed(model: string, text: string | string[]): Promise<number[][]>;
}
