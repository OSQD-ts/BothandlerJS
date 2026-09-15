import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { cleanAppearance } from "../challenge/appearance.js";
import type { ChallengeAppearance } from "../challenge/appearance.js";

/**
 * The challenge page as somebody last saved it from the dashboard.
 *
 * Kept by the listener, and in a file when `challengePage.file` is set, so a page designed
 * on the dashboard is still the page after the process restarts — which is the whole
 * point of designing it there rather than in code. Without a file it lasts as long as the
 * process, and the page says so rather than letting a save look more permanent than it is.
 *
 * Written the way saved filters are: whole, to a temporary file renamed over the real one,
 * and a failure to write keeps the settings in memory and says so.
 */
const FORMAT = "bothandlerjs/challenge-page";

export class ChallengePageStore {
  private current: ChallengeAppearance | undefined;

  constructor(
    readonly file: string | undefined,
    private readonly warn: (message: string) => void,
  ) {
    if (file !== undefined) this.load(file);
  }

  /** What was saved, or `undefined` when nothing has been. */
  saved(): ChallengeAppearance | undefined {
    return this.current;
  }

  /** Replaces what is saved. Returns whether it reached the file, when there is one. */
  save(appearance: ChallengeAppearance): { persisted: boolean } {
    this.current = appearance;
    return { persisted: this.persist() };
  }

  private load(file: string): void {
    let body: string;
    try {
      body = readFileSync(file, "utf8");
    } catch (error) {
      // No file yet is the normal first run. Anything else is worth a word.
      if ((error as { code?: string }).code !== "ENOENT") this.warn(`The challenge page could not be read from ${file}: ${(error as Error).message}. Using the page from code.`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch (error) {
      this.warn(`The challenge page in ${file} is not valid JSON (${(error as Error).message}). Using the page from code; the file will be replaced on the next save.`);
      return;
    }
    const document = parsed as { format?: unknown; appearance?: unknown };
    if (typeof parsed !== "object" || parsed === null || document.format !== FORMAT) {
      this.warn(`${file} is not a saved challenge page. Using the page from code; the file will be replaced on the next save.`);
      return;
    }
    // Checked again on the way in. The file is ours, but it is a file, and what is in it
    // ends up on a public page.
    const { appearance, errors } = cleanAppearance(document.appearance);
    if (errors.length > 0) {
      this.warn(`The challenge page in ${file} was not used: ${errors.join(" ")}`);
      return;
    }
    this.current = appearance;
  }

  private persist(): boolean {
    if (this.file === undefined) return false;
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(temporary, `${JSON.stringify({ format: FORMAT, version: 1, appearance: this.current ?? {} }, null, 2)}\n`, "utf8");
      renameSync(temporary, this.file);
      return true;
    } catch (error) {
      this.warn(`The challenge page could not be written to ${this.file}: ${(error as Error).message}. It is applied, and kept in memory until the process ends.`);
      return false;
    }
  }
}
