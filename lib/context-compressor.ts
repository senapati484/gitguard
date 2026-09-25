/**
 * lib/context-compressor.ts
 *
 * Intelligent Context Compression Engine for GitGuard.
 *
 * Optimizes diffs and code hunks before sending to LLMs (Groq / Gemini / Claude):
 *   1. Noise Filtering: Automatically discards package locks, build artifacts, minified bundles, images, maps.
 *   2. Hunk Pruning: Strips non-essential surrounding unchanged lines while preserving function headers.
 *   3. Intelligent Chunking: Batches files when a PR or push touches many files so no file is dropped.
 *   4. Model Routing: Routes massive diffs (>25KB) directly to Gemini 2.5 Flash (1M context) to avoid Groq TPM limits,
 *      while using Groq (llama-3.3-70b-versatile) for sub-second analysis on normal changesets.
 */

export interface CompressedHunk {
  file: string;
  startLine: number;
  endLine: number;
  hunkHeader: string;
  diffText: string;
  addedLinesCount: number;
  isLogicCode: boolean;
}

export interface HunkBatch {
  batchIndex: number;
  totalBatches: number;
  files: string[];
  hunks: CompressedHunk[];
  promptContext: string;
  estimatedTokens: number;
}

// Noise patterns to immediately ignore from AI review
const NOISE_FILE_PATTERNS: RegExp[] = [
  /package-lock\.json$/i,
  /pnpm-lock\.yaml$/i,
  /yarn\.lock$/i,
  /bun\.lockb$/i,
  /\.lock$/i,
  /\.min\.(js|css)$/i,
  /\.map$/i,
  /\.(png|jpe?g|gif|svg|ico|webp|avif|woff2?|ttf|eot|pdf|zip|tar|gz)$/i,
  /\.d\.ts$/i,
  /(dist|build|\.next|out|coverage|node_modules)\//i,
];

// File extensions prioritized for logic & correctness scanning
const LOGIC_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs",
  "py", "go", "rs", "java", "c", "cpp", "h", "hpp",
  "cs", "php", "rb", "swift", "kt", "scala",
  "sql", "sh", "bash"
]);

/**
 * Checks if a file path is eligible for AI code review.
 */
export function isEligibleFile(filePath: string): boolean {
  if (!filePath) return false;
  const normalized = filePath.replace(/\\/g, "/");
  return !NOISE_FILE_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Checks if a file extension represents executable logic (vs markdown/config/styles).
 */
export function isLogicFile(filePath: string): boolean {
  const ext = filePath.split(".").pop()?.toLowerCase() || "";
  return LOGIC_EXTENSIONS.has(ext);
}

/**
 * Compresses an individual hunk text:
 * - Trims excessive unchanged context lines (keeps max 2 unchanged context lines around edits)
 * - Removes blank unchanged lines
 */
export function compressHunkDiff(hunkLines: string[]): string {
  const compressed: string[] = [];
  let consecutiveUnchanged = 0;

  for (const line of hunkLines) {
    if (line.startsWith("+") || line.startsWith("-")) {
      consecutiveUnchanged = 0;
      compressed.push(line);
    } else if (line.startsWith("@@")) {
      compressed.push(line);
      consecutiveUnchanged = 0;
    } else {
      // Unchanged context line
      consecutiveUnchanged++;
      if (consecutiveUnchanged <= 2 && line.trim().length > 0) {
        compressed.push(line);
      }
    }
  }

  return compressed.join("\n");
}

/**
 * Parses and compresses unified diff into structured CompressedHunk array.
 */
export function extractCompressedHunks(diff: string): CompressedHunk[] {
  if (!diff || !diff.trim()) return [];

  const hunks: CompressedHunk[] = [];
  const lines = diff.split("\n");

  let currentFile = "";
  let currentHunkLines: string[] = [];
  let hunkStartLine = 1;
  let hunkHeader = "";
  let addedLinesCount = 0;

  function flushCurrentHunk() {
    if (currentFile && isEligibleFile(currentFile) && currentHunkLines.length > 0 && addedLinesCount > 0) {
      const compressedText = compressHunkDiff(currentHunkLines);
      hunks.push({
        file: currentFile,
        startLine: hunkStartLine,
        endLine: hunkStartLine + currentHunkLines.length,
        hunkHeader,
        diffText: compressedText,
        addedLinesCount,
        isLogicCode: isLogicFile(currentFile),
      });
    }
    currentHunkLines = [];
    addedLinesCount = 0;
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git ")) {
      flushCurrentHunk();
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      currentFile = match ? match[2] : "";
    } else if (line.startsWith("+++ b/")) {
      currentFile = line.slice(6);
    } else if (line.startsWith("@@ ")) {
      flushCurrentHunk();
      if (!isEligibleFile(currentFile)) continue;

      hunkHeader = line;
      const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      hunkStartLine = match ? parseInt(match[1], 10) : 1;
      currentHunkLines.push(line);
    } else if (currentHunkLines.length > 0) {
      if (!isEligibleFile(currentFile)) continue;
      currentHunkLines.push(line);
      if (line.startsWith("+") && !line.startsWith("+++")) {
        addedLinesCount++;
      }
    }
  }

  flushCurrentHunk();

  // Sort logic files first so primary code correctness is prioritized
  return hunks.sort((a, b) => {
    if (a.isLogicCode && !b.isLogicCode) return -1;
    if (!a.isLogicCode && b.isLogicCode) return 1;
    return 0;
  });
}

/**
 * Partitions hunks into batches sized appropriately for model inference.
 * Prevents dropping files while respecting TPM/context limits.
 */
export function batchHunksForInference(
  hunks: CompressedHunk[],
  maxBatchChars = 16_000
): HunkBatch[] {
  if (hunks.length === 0) return [];

  const batches: HunkBatch[] = [];
  let currentHunks: CompressedHunk[] = [];
  let currentChars = 0;

  for (const hunk of hunks) {
    const hunkLength = hunk.diffText.length + hunk.file.length + 50;

    if (currentHunks.length > 0 && currentChars + hunkLength > maxBatchChars) {
      // Flush current batch
      const files = Array.from(new Set(currentHunks.map((h) => h.file)));
      const promptContext = currentHunks
        .map((h) => `File: ${h.file}\nHunk: ${h.hunkHeader}\n\`\`\`diff\n${h.diffText}\n\`\`\``)
        .join("\n\n---\n\n");

      batches.push({
        batchIndex: batches.length + 1,
        totalBatches: 0, // updated after loop
        files,
        hunks: currentHunks,
        promptContext,
        estimatedTokens: Math.ceil(currentChars / 3.8),
      });

      currentHunks = [hunk];
      currentChars = hunkLength;
    } else {
      currentHunks.push(hunk);
      currentChars += hunkLength;
    }
  }

  if (currentHunks.length > 0) {
    const files = Array.from(new Set(currentHunks.map((h) => h.file)));
    const promptContext = currentHunks
      .map((h) => `File: ${h.file}\nHunk: ${h.hunkHeader}\n\`\`\`diff\n${h.diffText}\n\`\`\``)
      .join("\n\n---\n\n");

    batches.push({
      batchIndex: batches.length + 1,
      totalBatches: 0,
      files,
      hunks: currentHunks,
      promptContext,
      estimatedTokens: Math.ceil(currentChars / 3.8),
    });
  }

  // Update total batches count
  for (const b of batches) {
    b.totalBatches = batches.length;
  }

  return batches;
}
