import { appendFileSync, renameSync, statSync } from "node:fs";

/**
 * Writes each structured record to stderr when `echo` is set and, given a path, appends it to that
 * JSONL file.
 * The file rotates to `<path>.1` … `<path>.<keep>` before a record would push it past maxBytes.
 */
export function createRecordLog(
  path: string | undefined,
  maxBytes: number,
  keep: number,
  echo: boolean,
): (record: Record<string, unknown>) => void {
  let size = path === undefined ? 0 : sizeOf(path);
  return (record) => {
    const line = `${JSON.stringify(record)}\n`;
    if (echo) process.stderr.write(line);
    if (path === undefined) return;
    const bytes = Buffer.byteLength(line);
    if (size > 0 && size + bytes > maxBytes) {
      for (let index = keep - 1; index >= 1; index--)
        renameIfPresent(`${path}.${index}`, `${path}.${index + 1}`);
      renameSync(path, `${path}.1`);
      size = 0;
    }
    appendFileSync(path, line, { mode: 0o600 });
    size += bytes;
  };
}

function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
}

function renameIfPresent(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
