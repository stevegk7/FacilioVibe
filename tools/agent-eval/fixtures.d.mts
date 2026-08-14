export interface EvalCase {
  /** Platform agent name, e.g. 'fv-voice'. */
  agent: string;
  /** Unique, stable — the summary table and any regression diff key on it. */
  name: string;
  /** The exact wrong reply this case exists to catch. */
  counterexample: string;
  /** Why the case is worth an inference. */
  why: string;
  /** The text sent as `facilio vibe agent run --input`. */
  input: string;
  /** true when the reply honours the contract, else a failure description. */
  expect(raw: string): true | string;
}

export const CASES: EvalCase[];
