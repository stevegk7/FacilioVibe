/** Declarations for recordPolicy.js — see that file for why it stays JS. */

export declare const RETIRED_NAME: RegExp;

export declare function isRetired(row: { name?: unknown } | null | undefined): boolean;

export declare function visibleRows<T extends { name?: unknown }>(
  rows: T[] | null | undefined,
  showRetired?: boolean,
): T[];
