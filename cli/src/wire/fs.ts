// Direct filesystem reads for the wiring modules, which inspect and edit a
// project on disk the way doctor discovery does rather than through the
// injected command deps.

import { readFile, stat } from "node:fs/promises";

import { isRecord } from "../output";

export async function readJsonFile(
  file: string,
): Promise<Record<string, unknown> | null> {
  const text = await readTextFile(file);
  if (text === null) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export async function readTextFile(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function isFile(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
