import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function fileVersionFromContent(
  stats: fs.Stats,
  content: string | Buffer,
): string {
  const contentHash = crypto.createHash("sha256").update(content).digest("hex");
  return `${stats.mtimeMs}:${stats.size}:${contentHash}`;
}

export function fileVersionFromFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  const stats = fs.statSync(filePath);
  return fileVersionFromContent(stats, content);
}

export function fileVersionOrNull(filePath: string): string | null {
  try {
    return fileVersionFromFile(filePath);
  } catch {
    return null;
  }
}

/** Coalesces the burst of notifications one save produces. */
const FILE_WATCH_DEBOUNCE_MS = 50;
/** Stat-polling fallback when native watching is unavailable. */
const FILE_WATCH_POLL_INTERVAL_MS = 500;

let activeWatchers = 0;

/**
 * How many file watches are currently open. Every subscriber (SSE stream or
 * live-socket channel) holds one; a count that does not return to its
 * baseline after subscribers leave is a leaked fs watcher.
 */
export function activeFileWatchCount(): number {
  return activeWatchers;
}

/**
 * Calls `onChange` (debounced) when `filePath` may have changed. Watches the
 * containing directory rather than the file: editors and agents often save
 * atomically (write a temp file, rename it over the target), which replaces
 * the inode a file watcher would be attached to. Falls back to stat polling
 * if native watching fails (unsupported filesystem, watcher limits, the
 * directory going away). Callers dedupe by content version.
 */
export function watchFileForChanges(
  filePath: string,
  onChange: () => void,
): () => void {
  const directory = path.dirname(filePath);
  const fileName = path.basename(filePath);
  let timer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;
  let polling = false;
  let stopped = false;
  activeWatchers += 1;

  const schedule = () => {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (!stopped) onChange();
    }, FILE_WATCH_DEBOUNCE_MS);
  };
  const poll = (current: fs.Stats, previous: fs.Stats) => {
    if (
      current.mtimeMs !== previous.mtimeMs ||
      current.size !== previous.size ||
      current.nlink !== previous.nlink
    ) {
      schedule();
    }
  };
  const fallBackToPolling = () => {
    watcher?.close();
    watcher = null;
    if (stopped || polling) return;
    polling = true;
    fs.watchFile(filePath, { interval: FILE_WATCH_POLL_INTERVAL_MS }, poll);
    // Do not miss a change that happened while switching.
    schedule();
  };

  try {
    watcher = fs.watch(directory, { persistent: false }, (_event, name) => {
      // Some platforms omit the name; then any entry may be ours.
      if (name === null || name.toString() === fileName) schedule();
    });
    watcher.on("error", fallBackToPolling);
  } catch {
    fallBackToPolling();
  }

  return () => {
    if (stopped) return;
    stopped = true;
    activeWatchers -= 1;
    if (timer) clearTimeout(timer);
    watcher?.close();
    if (polling) fs.unwatchFile(filePath, poll);
  };
}

/** Extra version checks after a subscription starts (see below). */
const STARTUP_RECHECK_MS = [250, 1_000, 3_000];

export interface MarkdownFileChange {
  path: string;
  exists: boolean;
  version: string | null;
}

/**
 * One `change` per distinct on-disk state of a markdown file: the watcher may
 * report a single write several times, and the tab recognizes its own saves by
 * version. Starts from the version the tab already has (`knownVersion`), not
 * from "now": a write between the tab's load and this subscription (or during
 * a reconnect) is then reported right away instead of being lost.
 */
export function subscribeMarkdownFileChanges(
  absolutePath: string,
  relativePath: string,
  knownVersion: string | null,
  onChange: (change: MarkdownFileChange) => void,
): () => void {
  let lastVersion: string | null =
    knownVersion ?? fileVersionOrNull(absolutePath);
  const sendIfChanged = () => {
    const version = fileVersionOrNull(absolutePath);
    if (version === lastVersion) return;
    lastVersion = version;
    onChange({ path: relativePath, exists: version !== null, version });
  };

  const stopWatching = watchFileForChanges(absolutePath, sendIfChanged);
  if (knownVersion) sendIfChanged();
  // A native watcher starts asynchronously (FSEvents on macOS): a write in
  // the first moments after subscribing can go unreported. Under load this
  // was seen to drop a write ~300 ms after the subscription entirely, so look
  // again a few times while the watcher settles.
  const startupChecks = STARTUP_RECHECK_MS.map((delay) => {
    const timer = setTimeout(sendIfChanged, delay);
    timer.unref?.();
    return timer;
  });
  return () => {
    for (const timer of startupChecks) clearTimeout(timer);
    stopWatching();
  };
}
