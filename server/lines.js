import { open } from 'node:fs/promises';

const NL = 10;
const HEAD = 360;

/**
 * Streams the complete lines of `path` from byte `start`. `filter(head)` receives the first
 * HEAD bytes of each line (latin1), so multi-megabyte lines that are not needed are skipped
 * without being copied or decoded. Returns the offset just past the last complete line, which
 * is where the next incremental scan should resume (a half-written trailing line is left alone).
 */
export async function scanLines(path, start, filter, onLine, { skipFirst = false, chunkSize = 4 << 20 } = {}) {
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.allocUnsafe(chunkSize);
    let pos = start;
    let resume = start;
    let parts = [];
    let partsLen = 0;
    let state = skipFirst ? 2 : 0; // 0 = undecided, 1 = keep, 2 = skip
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, chunkSize, pos);
      if (bytesRead === 0) break;
      const view = buf.subarray(0, bytesRead);
      let i = 0;
      while (i < bytesRead) {
        const nl = view.indexOf(NL, i);
        const end = nl === -1 ? bytesRead : nl;
        if (state === 0 && (partsLen + end - i >= HEAD || nl !== -1)) {
          const head = partsLen === 0
            ? view.toString('latin1', i, Math.min(end, i + HEAD))
            : Buffer.concat([...parts, view.subarray(i, Math.min(end, i + HEAD))]).toString('latin1', 0, HEAD);
          state = filter(head) ? 1 : 2;
          if (state === 2) {
            parts = [];
            partsLen = 0;
          }
        }
        if (state !== 2 && end > i) {
          parts.push(Buffer.from(view.subarray(i, end)));
          partsLen += end - i;
        }
        if (nl === -1) break;
        if (state === 1 && partsLen > 0) onLine(Buffer.concat(parts, partsLen).toString('utf8'));
        parts = [];
        partsLen = 0;
        state = 0;
        i = nl + 1;
        resume = pos + i;
      }
      pos += bytesRead;
    }
    return resume;
  } finally {
    await fh.close();
  }
}

/** Reads at most `maxBytes` from the end of a file and returns its complete lines. */
export async function tailLines(path, size, maxBytes) {
  const start = Math.max(0, size - maxBytes);
  const fh = await open(path, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    const { bytesRead } = await fh.read(buf, 0, buf.length, start);
    const lines = buf.toString('utf8', 0, bytesRead).split('\n');
    if (start > 0) lines.shift();
    return lines.filter(Boolean);
  } finally {
    await fh.close();
  }
}
