/** Types for `adr.mjs`, so a TypeScript test in any package can import it by relative path. */

export interface Adr {
	/** Zero-padded number, e.g. `"0001"`. */
	id: string;
	/** Repo-relative path, for failure messages that say where to look. */
	file: string;
	/** Absolute path on disk. */
	path: string;
	/** The whole document. */
	text: string;
	/** The rule ids the document states, in order — `["M1", "M2", "M3", "M4"]`. Never empty. */
	rules: string[];
}

export declare function readAdr(number: number): Adr;
