import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_STALE_TEMP_INDEX_MS = 24 * 60 * 60 * 1000;
const MEMORY_INDEX_SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

export type StaleMemoryIndexTempCleanupResult = {
  removed: number;
  failed: number;
};

export async function moveMemoryIndexFiles(sourceBase: string, targetBase: string): Promise<void> {
  const suffixes = ["", "-wal", "-shm"];
  for (const suffix of suffixes) {
    const source = `${sourceBase}${suffix}`;
    const target = `${targetBase}${suffix}`;
    try {
      await fs.rename(source, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
        throw err;
      }
    }
  }
}

export async function removeMemoryIndexFiles(basePath: string): Promise<void> {
  const suffixes = ["", "-wal", "-shm"];
  await Promise.all(suffixes.map((suffix) => fs.rm(`${basePath}${suffix}`, { force: true })));
}

function stripMemoryIndexSidecarSuffix(fileName: string): string {
  for (const suffix of MEMORY_INDEX_SIDECAR_SUFFIXES) {
    if (fileName.endsWith(suffix)) {
      return fileName.slice(0, -suffix.length);
    }
  }
  return fileName;
}

export async function cleanupStaleMemoryIndexTempFiles(params: {
  targetPath: string;
  nowMs?: number;
  staleMs?: number;
}): Promise<StaleMemoryIndexTempCleanupResult> {
  const staleMs = params.staleMs ?? DEFAULT_STALE_TEMP_INDEX_MS;
  const nowMs = params.nowMs ?? Date.now();
  const dir = path.dirname(params.targetPath);
  const tempPrefix = `${path.basename(params.targetPath)}.tmp-`;
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return { removed: 0, failed: 0 };
  }

  const candidateBaseNames = new Set<string>();
  for (const entry of entries) {
    if (!entry.isFile()) {
      continue;
    }
    if (!entry.name.startsWith(tempPrefix)) {
      continue;
    }
    candidateBaseNames.add(stripMemoryIndexSidecarSuffix(entry.name));
  }

  let removed = 0;
  let failed = 0;
  for (const baseName of candidateBaseNames) {
    const basePath = path.join(dir, baseName);
    const paths = [basePath, `${basePath}-wal`, `${basePath}-shm`];
    let newestMtimeMs: number | null = null;
    for (const candidatePath of paths) {
      try {
        const stat = await fs.stat(candidatePath);
        newestMtimeMs = Math.max(newestMtimeMs ?? 0, stat.mtimeMs);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          failed += 1;
        }
      }
    }
    if (newestMtimeMs === null || nowMs - newestMtimeMs < staleMs) {
      continue;
    }
    try {
      await removeMemoryIndexFiles(basePath);
      removed += 1;
    } catch {
      failed += 1;
    }
  }

  return { removed, failed };
}

export async function swapMemoryIndexFiles(targetPath: string, tempPath: string): Promise<void> {
  const backupPath = `${targetPath}.backup-${randomUUID()}`;
  await moveMemoryIndexFiles(targetPath, backupPath);
  try {
    await moveMemoryIndexFiles(tempPath, targetPath);
  } catch (err) {
    await moveMemoryIndexFiles(backupPath, targetPath);
    throw err;
  }
  await removeMemoryIndexFiles(backupPath);
}

export async function runMemoryAtomicReindex<T>(params: {
  targetPath: string;
  tempPath: string;
  build: () => Promise<T>;
}): Promise<T> {
  try {
    const result = await params.build();
    await swapMemoryIndexFiles(params.targetPath, params.tempPath);
    return result;
  } catch (err) {
    await removeMemoryIndexFiles(params.tempPath);
    throw err;
  }
}
