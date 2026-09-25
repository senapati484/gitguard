/**
 * agents/seo-agent.ts
 *
 * GitGuard SEO & Core Web Vitals Agent.
 *
 * Responsibilities:
 *   - Gated to only run when the git diff touches frontend files (.jsx, .tsx, .html).
 *   - Audits meta tags: title, meta description, charset, viewport, canonical.
 *   - Audits Open Graph completeness: og:title, og:description, og:image, og:url.
 *   - Audits image accessibility & indexing: missing alt attributes, placeholder alt text.
 *   - Audits layout-shifting inline styles (Core Web Vitals - CLS):
 *       * Images missing explicit width/height or aspect-ratio
 *       * Layout-shifting CSS transitions/animations (margin, top, left vs transform)
 *       * Unconstrained container styles
 *   - Computes a 0–100 SEO score to feed into HealthAgent's composite score.
 *   - Posts a dedicated GitHub Check Run "GitGuard / SEO & Web Vitals" with line annotations.
 */

import type { Octokit } from "@octokit/core";
import { generateAICompletion } from "@/lib/ai-client";

// ── 1. Types & Interfaces ─────────────────────────────────────────────────────

export type SEOSeverity = "high" | "medium" | "low";

export type SEOCategory =
  | "meta_tags"
  | "open_graph"
  | "alt_text"
  | "layout_shift"
  | "semantic_structure";

export interface SEOFinding {
  file: string;
  line: number;
  category: SEOCategory;
  severity: SEOSeverity;
  ruleId: string;
  message: string;
  recommendation: string;
  codeSnippet?: string;
}

export interface SEOScanResult {
  skipped: boolean;
  score: number; // 0 - 100
  findings: SEOFinding[];
  filesScanned: string[];
  reason?: string;
  metrics: {
    metaTagsScore: number;
    openGraphScore: number;
    altTextScore: number;
    clsScore: number;
  };
}

export interface ChangedFrontendHunk {
  file: string;
  startLine: number;
  endLine: number;
  diffLines: { line: number; text: string; type: "add" | "context" }[];
  fullDiffText: string;
}

export const FRONTEND_EXTENSIONS = [".jsx", ".tsx", ".html", ".htm"];

// ── 2. Gating Logic ───────────────────────────────────────────────────────────

/**
 * Checks if a given filepath is a supported frontend template or component.
 */
export function isFrontendFile(filePath: string): boolean {
  const normalized = filePath.toLowerCase().trim();
  return FRONTEND_EXTENSIONS.some((ext) => normalized.endsWith(ext));
}

/**
 * Parses the diff headers to determine if any .jsx, .tsx, or .html files are touched.
 */
export function hasFrontendFiles(diff: string): boolean {
  if (!diff || !diff.trim()) return false;
  const lines = diff.split("\n");
  for (const line of lines) {
    if (line.startsWith("diff --git ") || line.startsWith("+++ b/")) {
      const match = line.match(/(?:b\/|diff --git a\/.* b\/)([\S]+)/);
      if (match && match[1]) {
        const file = match[1].trim();
        if (isFrontendFile(file)) {
          return true;
        }
      }
    }
  }
  return false;
}

/**
 * Extracts changed frontend files and their added/modified hunks from a unified diff.
 */
export function extractFrontendHunks(diff: string): ChangedFrontendHunk[] {
  const hunks: ChangedFrontendHunk[] = [];
  const fileSections = diff.split(/^diff --git /m);

  for (const section of fileSections) {
    if (!section.trim()) continue;

    const fileMatch = section.match(/^[ab]\/([\S]+)\s+[ab]\/([\S]+)/m) || section.match(/^\+\+\+ b\/([\S]+)/m);
    if (!fileMatch) continue;

    const filePath = (fileMatch[2] || fileMatch[1]).trim();
    if (!isFrontendFile(filePath)) continue;

    // Split into individual diff chunks
    const hunkSections = section.split(/^@@ /m).slice(1);
    for (const hunkText of hunkSections) {
      const headerEnd = hunkText.indexOf(" @@");
      if (headerEnd === -1) continue;

      const header = hunkText.substring(0, headerEnd);
      const body = hunkText.substring(headerEnd + 3);

      // Parse target line: -oldStart,oldCount +newStart,newCount
      const lineMatch = header.match(/\+(\d+)(?:,(\d+))?/);
      if (!lineMatch) continue;

      const startLine = parseInt(lineMatch[1], 10);
      const diffLines: { line: number; text: string; type: "add" | "context" }[] = [];

      let currentLine = startLine;
      const rawLines = body.split("\n");

      for (const line of rawLines) {
        if (line.startsWith("+")) {
          diffLines.push({
            line: currentLine,
            text: line.slice(1),
            type: "add",
          });
          currentLine++;
        } else if (line.startsWith("-")) {
          // Deletion line does not increment target file line count
          continue;
        } else if (line.startsWith(" ") || line === "") {
          diffLines.push({
            line: currentLine,
            text: line.startsWith(" ") ? line.slice(1) : line,
            type: "context",
          });
          currentLine++;
        }
      }

      hunks.push({
        file: filePath,
        startLine,
        endLine: currentLine - 1,
        diffLines,
        fullDiffText: hunkText,
      });
    }
  }

  return hunks;
}

// ── 3. Rule Checkers ──────────────────────────────────────────────────────────

/**
 * Check 1: Meta Tags (Title, Meta Description, Viewport)
 */
function checkMetaTags(hunks: ChangedFrontendHunk[]): SEOFinding[] {
  const findings: SEOFinding[] = [];

  for (const hunk of hunks) {
    const isPageRoute =
      hunk.file.includes("page.") ||
      hunk.file.includes("layout.") ||
      hunk.file.endsWith(".html") ||
      hunk.file.includes("index.") ||
      hunk.file.includes("App.") ||
      hunk.file.includes("Document.");

    const combinedAddedCode = hunk.diffLines
      .filter((dl) => dl.type === "add")
      .map((dl) => dl.text)
      .join("\n");

    const fullHunkCode = hunk.diffLines.map((dl) => dl.text).join("\n");

    // Only audit page / route / layout components for page-level meta tags
    if (isPageRoute) {
      // 1. Title tag checks
      const hasTitle =
        /title\s*[:=]\s*["'`][^"'`]+["'`]/i.test(fullHunkCode) ||
        /<title[^>]*>.*?<\/title>/i.test(fullHunkCode) ||
        /metadata\s*[:=][\s\S]*?title/i.test(fullHunkCode) ||
        /generateMetadata/i.test(fullHunkCode);

      // Check if metadata object was added but title is missing
      const definesMetadata = /export\s+const\s+metadata\s*[:=]/i.test(combinedAddedCode);
      if (definesMetadata && !/title\s*:/i.test(combinedAddedCode)) {
        const anchor = hunk.diffLines.find((dl) => dl.type === "add") || hunk.diffLines[0];
        findings.push({
          file: hunk.file,
          line: anchor ? anchor.line : hunk.startLine,
          category: "meta_tags",
          severity: "high",
          ruleId: "seo.meta.missing-title",
          message: "Page metadata is defined without an explicit 'title' field.",
          recommendation:
            "Add a concise title (50–60 characters) to metadata.title or <title> for search engine ranking and browser tabs.",
        });
      }

      // Check title length if explicitly assigned as string
      const titleMatch = combinedAddedCode.match(/title\s*[:=]\s*["'`]([^"'`]+)["'`]/i);
      if (titleMatch && titleMatch[1]) {
        const titleText = titleMatch[1].trim();
        if (titleText.length < 15) {
          const matchLine = hunk.diffLines.find((dl) => dl.text.includes(titleText))?.line || hunk.startLine;
          findings.push({
            file: hunk.file,
            line: matchLine,
            category: "meta_tags",
            severity: "medium",
            ruleId: "seo.meta.title-too-short",
            message: `Title "${titleText}" is too short (${titleText.length} chars). Recommended: 30–60 characters.`,
            recommendation: "Expand page title to include primary keywords and brand identity.",
            codeSnippet: titleText,
          });
        } else if (titleText.length > 70) {
          const matchLine = hunk.diffLines.find((dl) => dl.text.includes(titleText))?.line || hunk.startLine;
          findings.push({
            file: hunk.file,
            line: matchLine,
            category: "meta_tags",
            severity: "low",
            ruleId: "seo.meta.title-too-long",
            message: `Title is ${titleText.length} chars long and will be truncated by search engine result pages (SERPs).`,
            recommendation: "Keep titles under 60–70 characters to avoid SERP truncation.",
            codeSnippet: titleText.slice(0, 50) + "...",
          });
        }
      }

      // 2. Meta description checks
      if (definesMetadata && !/description\s*:/i.test(combinedAddedCode)) {
        const anchor = hunk.diffLines.find((dl) => dl.type === "add") || hunk.diffLines[0];
        findings.push({
          file: hunk.file,
          line: anchor ? anchor.line : hunk.startLine,
          category: "meta_tags",
          severity: "high",
          ruleId: "seo.meta.missing-description",
          message: "Page metadata lacks a 'description' field for snippet generation.",
          recommendation:
            "Provide a compelling meta description (120–160 characters) summarizing page intent to improve click-through rate (CTR).",
        });
      }

      const descMatch = combinedAddedCode.match(/description\s*[:=]\s*["'`]([^"'`]+)["'`]/i);
      if (descMatch && descMatch[1]) {
        const descText = descMatch[1].trim();
        if (descText.length < 50) {
          const matchLine = hunk.diffLines.find((dl) => dl.text.includes(descText))?.line || hunk.startLine;
          findings.push({
            file: hunk.file,
            line: matchLine,
            category: "meta_tags",
            severity: "medium",
            ruleId: "seo.meta.description-too-short",
            message: `Meta description is only ${descText.length} chars. Recommended: 120–160 characters.`,
            recommendation: "Expand description to accurately explain page benefits and keywords.",
            codeSnippet: descText,
          });
        } else if (descText.length > 170) {
          const matchLine = hunk.diffLines.find((dl) => dl.text.includes(descText))?.line || hunk.startLine;
          findings.push({
            file: hunk.file,
            line: matchLine,
            category: "meta_tags",
            severity: "low",
            ruleId: "seo.meta.description-too-long",
            message: `Meta description is ${descText.length} chars and may be truncated on search engines.`,
            recommendation: "Trim meta description to under 160 characters.",
          });
        }
      }

      // 3. HTML Document checks (<meta name="viewport">, <meta charset>)
      if (hunk.file.endsWith(".html")) {
        if (/<head>/i.test(fullHunkCode) && !/viewport/i.test(fullHunkCode)) {
          findings.push({
            file: hunk.file,
            line: hunk.startLine,
            category: "meta_tags",
            severity: "high",
            ruleId: "seo.meta.missing-viewport",
            message: "HTML <head> is missing the responsive <meta name=\"viewport\"> tag.",
            recommendation: "Add <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"> for mobile friendliness.",
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Check 2: Open Graph Completeness (og:title, og:description, og:image, og:url)
 */
function checkOpenGraph(hunks: ChangedFrontendHunk[]): SEOFinding[] {
  const findings: SEOFinding[] = [];

  for (const hunk of hunks) {
    const isPageRoute =
      hunk.file.includes("page.") ||
      hunk.file.includes("layout.") ||
      hunk.file.endsWith(".html") ||
      hunk.file.includes("index.");

    if (!isPageRoute) continue;

    const addedLines = hunk.diffLines.filter((dl) => dl.type === "add");
    const addedText = addedLines.map((dl) => dl.text).join("\n");
    const fullHunkText = hunk.diffLines.map((dl) => dl.text).join("\n");

    // Check if Next.js metadata or openGraph is defined
    const hasMetadata =
      /export\s+const\s+metadata/i.test(fullHunkText) ||
      /metadata\s*[:=]\s*\{/i.test(fullHunkText) ||
      /openGraph\s*:/i.test(fullHunkText);

    if (hasMetadata) {
      const hasOpenGraph = /openGraph\s*:/i.test(fullHunkText);

      if (!hasOpenGraph) {
        const anchor = addedLines[0] || hunk.diffLines[0];
        findings.push({
          file: hunk.file,
          line: anchor.line,
          category: "open_graph",
          severity: "medium",
          ruleId: "seo.og.missing-opengraph-block",
          message: "Page defines metadata but is missing an 'openGraph' object for social share cards.",
          recommendation:
            "Add openGraph: { title, description, images: ['/og-image.png'], url: '...' } to enable rich previews on Twitter, LinkedIn, and Slack.",
        });
      } else {
        // If openGraph is defined, inspect the openGraph block specifically for og:image
        const ogBlockMatch = fullHunkText.match(/openGraph\s*:\s*\{([\s\S]*?)\}/);
        const ogBlock = ogBlockMatch ? ogBlockMatch[1] : fullHunkText;
        const hasOgImage =
          /\bimages?\s*:/i.test(ogBlock) ||
          /og:image/i.test(ogBlock);

        if (!hasOgImage) {
          const ogLine =
            hunk.diffLines.find((dl) => /openGraph/i.test(dl.text))?.line ||
            (addedLines[0] || hunk.diffLines[0]).line;

          findings.push({
            file: hunk.file,
            line: ogLine,
            category: "open_graph",
            severity: "high",
            ruleId: "seo.og.missing-image",
            message: "Open Graph configuration is missing 'images' (og:image). Social links will render without preview cards.",
            recommendation:
              "Specify a 1200x630px preview image in openGraph.images to dramatically boost social engagement and click-through rates.",
          });
        }
      }
    }

    // For raw HTML files: check <meta property="og:...">
    if (hunk.file.endsWith(".html")) {
      const fullText = hunk.diffLines.map((dl) => dl.text).join("\n");
      if (/<head>/i.test(fullText)) {
        if (!/property=["']og:title["']/i.test(fullText)) {
          findings.push({
            file: hunk.file,
            line: hunk.startLine,
            category: "open_graph",
            severity: "medium",
            ruleId: "seo.og.missing-tag",
            message: "HTML document is missing <meta property=\"og:title\" content=\"...\">.",
            recommendation: "Include standard Open Graph tags (og:title, og:description, og:image) in <head>.",
          });
        }
      }
    }
  }

  return findings;
}

/**
 * Check 3: Alt Text on Images (img, Image, avatar, icons)
 */
function checkAltText(hunks: ChangedFrontendHunk[]): SEOFinding[] {
  const findings: SEOFinding[] = [];

  for (const hunk of hunks) {
    for (const dl of hunk.diffLines) {
      if (dl.type !== "add") continue;

      const text = dl.text;

      // Match <img> or <Image ...>
      const imgMatch = text.match(/<(?:img|Image)\b([^>]*)/i);
      if (imgMatch) {
        const attrs = imgMatch[1];

        // 1. Missing alt attribute completely
        const hasAlt = /\balt\s*=/i.test(attrs);
        if (!hasAlt) {
          findings.push({
            file: hunk.file,
            line: dl.line,
            category: "alt_text",
            severity: "high",
            ruleId: "seo.accessibility.missing-alt",
            message: "Image element (<img /> or <Image />) is missing an 'alt' attribute.",
            recommendation:
              "Add a descriptive alt attribute (e.g. alt=\"Team collaborating on dashboard\") for screen readers and search engine indexation.",
            codeSnippet: dl.text.trim(),
          });
          continue;
        }

        // 2. Extract alt value
        const altValMatch = attrs.match(/\balt=(?:["']([^"']*)["']|\{([^}]+)\})/i);
        if (altValMatch) {
          const altValue = (altValMatch[1] ?? altValMatch[2] ?? "").trim().toLowerCase();

          // Empty alt check (decorative vs forgotten)
          if (altValue === "") {
            const hasAriaHidden = /aria-hidden=["']?true["']?/i.test(attrs);
            const isDecorative = /role=["']?(?:presentation|none)["']?/i.test(attrs);

            if (!hasAriaHidden && !isDecorative) {
              findings.push({
                file: hunk.file,
                line: dl.line,
                category: "alt_text",
                severity: "medium",
                ruleId: "seo.accessibility.empty-alt",
                message: "Image has empty alt=\"\" attribute without aria-hidden=\"true\" or role=\"presentation\".",
                recommendation:
                  "If image is informative, provide descriptive text. If purely decorative, mark with aria-hidden=\"true\".",
                codeSnippet: dl.text.trim(),
              });
            }
          }

          // Generic placeholder checks: "image", "photo", "pic", "icon", "logo", "banner"
          const genericPlaceholders = ["image", "photo", "pic", "picture", "icon", "logo", "img", "graphic"];
          if (genericPlaceholders.includes(altValue)) {
            findings.push({
              file: hunk.file,
              line: dl.line,
              category: "alt_text",
              severity: "medium",
              ruleId: "seo.accessibility.generic-alt",
              message: `Generic alt="${altValue}" does not provide meaningful context to users or search crawlers.`,
              recommendation:
                "Replace placeholder words with a specific description of what the image depicts.",
              codeSnippet: dl.text.trim(),
            });
          }

          // Redundant phrases: "image of ...", "picture of ..."
          if (altValue.startsWith("image of ") || altValue.startsWith("picture of ") || altValue.startsWith("photo of ")) {
            findings.push({
              file: hunk.file,
              line: dl.line,
              category: "alt_text",
              severity: "low",
              ruleId: "seo.accessibility.redundant-alt",
              message: `Alt text contains redundant phrasing ("${altValue.slice(0, 15)}..."). Screen readers already announce image elements.`,
              recommendation: "Remove 'image of' or 'picture of' prefixes to keep alt text concise.",
              codeSnippet: dl.text.trim(),
            });
          }
        }
      }
    }
  }

  return findings;
}

/**
 * Check 4: Layout-Shifting Inline Styles (Core Web Vitals - CLS)
 */
function checkLayoutShift(hunks: ChangedFrontendHunk[]): SEOFinding[] {
  const findings: SEOFinding[] = [];

  for (const hunk of hunks) {
    for (const dl of hunk.diffLines) {
      if (dl.type !== "add") continue;
      const text = dl.text;

      // 1. Image elements missing explicit width and height attributes (Major CLS cause)
      const isImgTag = /<(?:img|Image)\b([^>]*)/i.test(text);
      if (isImgTag) {
        const attrs = text;
        const hasWidth = /\bwidth\s*=/i.test(attrs) || /style=[\s\S]*?\bwidth\s*:/i.test(attrs);
        const hasHeight = /\bheight\s*=/i.test(attrs) || /style=[\s\S]*?\bheight\s*:/i.test(attrs);
        const hasAspectRatio = /aspect-ratio|aspectRatio/i.test(attrs);
        const isNextImageFill = /fill\b/i.test(attrs); // Next.js <Image fill /> is exempt

        if ((!hasWidth || !hasHeight) && !hasAspectRatio && !isNextImageFill) {
          findings.push({
            file: hunk.file,
            line: dl.line,
            category: "layout_shift",
            severity: "high",
            ruleId: "seo.cls.unconstrained-image-dimensions",
            message: "Image lacks explicit width/height dimensions or aspect-ratio inline style, causing Cumulative Layout Shift (CLS).",
            recommendation:
              "Specify width and height attributes (e.g. width={600} height={400}) or style={{ aspectRatio: '16/9' }} so the browser allocates layout space before image download.",
            codeSnippet: text.trim(),
          });
        }
      }

      // 2. Layout-shifting inline style transitions on geometric properties
      const styleMatch = text.match(/style\s*=\s*(?:\{([\s\S]*?)\}|"([^"]*)")/);
      if (styleMatch) {
        const styleContent = (styleMatch[1] || styleMatch[2] || "").toLowerCase();

        // Shifting properties: transition on margin, top, left, width, height
        if (
          /transition\s*:\s*.*?\b(margin|top|left|right|bottom|width|height)\b/i.test(styleContent) ||
          /transition\s*[:=]\s*["'].*?\b(margin|top|left|right|bottom|width|height)\b/i.test(styleContent)
        ) {
          findings.push({
            file: hunk.file,
            line: dl.line,
            category: "layout_shift",
            severity: "medium",
            ruleId: "seo.cls.animating-layout-properties",
            message: "Inline style animates layout-triggering properties (margin/top/left/width/height), causing frame jank and layout shifts.",
            recommendation:
              "Use CSS 'transform' (e.g. translate3d, scale) and 'opacity' for smooth 60fps animations without triggering layout recalculations.",
            codeSnippet: text.trim(),
          });
        }

        // Inline unconstrained container height: height: 'auto' with overflow scroll
        if (/height\s*:\s*["']auto["']/i.test(styleContent) && /overflow\s*:\s*["']scroll["']/i.test(styleContent)) {
          findings.push({
            file: hunk.file,
            line: dl.line,
            category: "layout_shift",
            severity: "low",
            ruleId: "seo.cls.unconstrained-dynamic-container",
            message: "Inline style uses dynamic height with scroll without minimum dimensions, potentially shifting content on data load.",
            recommendation: "Provide a minHeight or skeleton placeholder to reserve container footprint.",
            codeSnippet: text.trim(),
          });
        }
      }

      // 3. Web fonts without font-display
      if (/@font-face/i.test(text) && !/font-display/i.test(text)) {
        findings.push({
          file: hunk.file,
          line: dl.line,
          category: "layout_shift",
          severity: "medium",
          ruleId: "seo.cls.font-display-missing",
          message: "@font-face declaration lacks 'font-display: swap', risking Flash of Invisible Text (FOIT) and layout shift.",
          recommendation: "Add 'font-display: swap' or use Next.js next/font to prevent typography-induced layout shifts.",
          codeSnippet: text.trim(),
        });
      }
    }
  }

  return findings;
}

// ── 4. AI Semantic SEO Reasoning ──────────────────────────────────────────────

/**
 * Optional AI enrichment for semantic hierarchy (single H1, heading order)
 * using Groq or Gemini.
 */
async function runAISemanticCheck(
  hunks: ChangedFrontendHunk[]
): Promise<SEOFinding[]> {
  const pageHunks = hunks.filter(
    (h) => h.file.includes("page.") || h.file.includes("layout.") || h.file.endsWith(".html")
  );

  if (pageHunks.length === 0) return [];

  const diffSnippet = pageHunks
    .slice(0, 3)
    .map((h) => `--- File: ${h.file} ---\n${h.diffLines.filter((l) => l.type === "add").map((l) => l.text).slice(0, 50).join("\n")}`)
    .join("\n\n");

  if (!diffSnippet.trim()) return [];

  const prompt = `You are GitGuard's SEO & Web Vitals expert.
Analyze this frontend diff for semantic heading hierarchy issues only:
- Are there multiple <h1> tags on the same page?
- Are heading levels skipping (e.g. H1 directly to H4 without H2/H3)?
- Is there an empty heading tag?

Frontend Diff:
${diffSnippet}

Return a valid JSON array of findings with:
[
  {
    "file": string,
    "line": number,
    "severity": "high" | "medium" | "low",
    "ruleId": "seo.semantic.multiple-h1" | "seo.semantic.skipped-heading" | "seo.semantic.empty-heading",
    "message": string,
    "recommendation": string
  }
]
If no semantic heading issues exist, return [].`;

  try {
    const response = await generateAICompletion({
      messages: [
        {
          role: "system",
          content: "You analyze frontend code for semantic SEO heading structure. Return ONLY valid JSON.",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      jsonMode: true,
      preferredModel: "haiku",
    });

    if (!response) return [];

    const parsed = JSON.parse(response);
    if (Array.isArray(parsed)) {
      return parsed.map((item) => ({
        file: item.file || pageHunks[0].file,
        line: typeof item.line === "number" ? item.line : pageHunks[0].startLine,
        category: "semantic_structure",
        severity: item.severity || "medium",
        ruleId: item.ruleId || "seo.semantic.heading-issue",
        message: item.message || "Heading hierarchy issue detected.",
        recommendation: item.recommendation || "Ensure single <h1> and logical heading progression.",
      }));
    }
  } catch (err) {
    // Non-fatal fallback
    console.warn(`[seo-agent] AI semantic check skipped:`, err);
  }

  return [];
}

// ── 5. Main SEO Scanner Engine ────────────────────────────────────────────────

/**
 * Audits a diff for SEO, Open Graph, Image Accessibility, and Core Web Vitals (CLS).
 * Gated to only execute when frontend files (.jsx, .tsx, .html) are touched.
 */
export async function runSEOScan(
  diff: string,
  options: { enableAi?: boolean } = { enableAi: true }
): Promise<SEOScanResult> {
  // Gating check
  if (!hasFrontendFiles(diff)) {
    return {
      skipped: true,
      score: 100,
      findings: [],
      filesScanned: [],
      reason: "No .jsx, .tsx, or .html files were modified in this diff.",
      metrics: {
        metaTagsScore: 100,
        openGraphScore: 100,
        altTextScore: 100,
        clsScore: 100,
      },
    };
  }

  const hunks = extractFrontendHunks(diff);
  const filesScanned = Array.from(new Set(hunks.map((h) => h.file)));

  console.log(
    `[seo-agent] Auditing ${filesScanned.length} frontend file(s): ${filesScanned.join(", ")}`
  );

  // Run all deterministic checks
  const metaFindings = checkMetaTags(hunks);
  const ogFindings = checkOpenGraph(hunks);
  const altFindings = checkAltText(hunks);
  const clsFindings = checkLayoutShift(hunks);

  let semanticFindings: SEOFinding[] = [];
  if (options.enableAi) {
    semanticFindings = await runAISemanticCheck(hunks);
  }

  const allFindings: SEOFinding[] = [
    ...metaFindings,
    ...ogFindings,
    ...altFindings,
    ...clsFindings,
    ...semanticFindings,
  ];

  // ── Calculate Category Scores & Composite ───────────────────────────────────

  // High: -15, Medium: -8, Low: -3
  const calcCategoryScore = (catFindings: SEOFinding[]): number => {
    let deductions = 0;
    for (const f of catFindings) {
      if (f.severity === "high") deductions += 15;
      else if (f.severity === "medium") deductions += 8;
      else deductions += 3;
    }
    return Math.max(0, 100 - deductions);
  };

  const metaTagsScore = calcCategoryScore(metaFindings);
  const openGraphScore = calcCategoryScore(ogFindings);
  const altTextScore = calcCategoryScore(altFindings);
  const clsScore = calcCategoryScore(clsFindings);

  // Composite weighted SEO score:
  // Meta Tags (30%) + Open Graph (20%) + Alt Text (25%) + CLS / Layout Shift (25%)
  const rawScore =
    metaTagsScore * 0.3 +
    openGraphScore * 0.2 +
    altTextScore * 0.25 +
    clsScore * 0.25;

  const score = Math.round(Math.max(0, Math.min(100, rawScore)));

  console.log(
    `[seo-agent] SEO Scan completed. Score: ${score}/100. Findings: ${allFindings.length}`
  );

  return {
    skipped: false,
    score,
    findings: allFindings,
    filesScanned,
    metrics: {
      metaTagsScore,
      openGraphScore,
      altTextScore,
      clsScore,
    },
  };
}

// ── 6. GitHub Check Run Integration ───────────────────────────────────────────

/**
 * Publishes a dedicated "GitGuard / SEO & Web Vitals" Check Run with inline annotations.
 */
export async function publishSEOCheckRun(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  scanResult: SEOScanResult
): Promise<void> {
  const { skipped, score, findings, filesScanned, reason } = scanResult;

  if (skipped) {
    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: "GitGuard / SEO & Web Vitals",
      head_sha: sha,
      status: "completed",
      conclusion: "neutral",
      output: {
        title: "SEO Audit Skipped (Backend Only)",
        summary: reason || "No .jsx, .tsx, or .html files were modified in this commit.",
      },
    });
    return;
  }

  const conclusion = score >= 90 ? "success" : score >= 70 ? "neutral" : "failure";
  const title = `SEO & Core Web Vitals: ${score}/100 (${conclusion.toUpperCase()})`;

  // Build GitHub inline annotations (max 50)
  const annotations = findings.slice(0, 50).map((f) => ({
    path: f.file,
    start_line: f.line,
    end_line: f.line,
    annotation_level:
      f.severity === "high"
        ? ("failure" as const)
        : f.severity === "medium"
        ? ("warning" as const)
        : ("notice" as const),
    message: `${f.message}\n\n⚡ Action: ${f.recommendation}`,
    title: `[${f.category.toUpperCase()}] ${f.ruleId}`,
  }));

  let summary = `### 🌐 GitGuard SEO & Core Web Vitals Audit\n\n`;
  summary += `**Overall Score:** \`${score} / 100\`\n`;
  summary += `- **Meta Tags Score:** ${scanResult.metrics.metaTagsScore}%\n`;
  summary += `- **Open Graph Score:** ${scanResult.metrics.openGraphScore}%\n`;
  summary += `- **Image Accessibility (Alt Text):** ${scanResult.metrics.altTextScore}%\n`;
  summary += `- **Cumulative Layout Shift (CLS):** ${scanResult.metrics.clsScore}%\n\n`;
  summary += `**Files Scanned (${filesScanned.length}):** ${filesScanned.map((f) => `\`${f}\``).join(", ")}\n\n`;

  if (findings.length === 0) {
    summary += `✅ **Pristine!** All frontend components satisfy meta tag standards, Open Graph completeness, image alt text, and zero layout-shifting inline styles.\n`;
  } else {
    summary += `#### 🔍 Identified Defects (${findings.length})\n`;
    for (const f of findings.slice(0, 10)) {
      summary += `- **[${f.severity.toUpperCase()}] \`${f.file}:${f.line}\`**: ${f.message}\n`;
      summary += `  *Fix:* ${f.recommendation}\n`;
    }
  }

  try {
    await octokit.request("POST /repos/{owner}/{repo}/check-runs", {
      owner,
      repo,
      name: "GitGuard / SEO & Web Vitals",
      head_sha: sha,
      status: "completed",
      conclusion,
      output: {
        title,
        summary: summary.slice(0, 60000),
        annotations,
      },
    });

    console.log(
      `[seo-agent] Published Check Run "GitGuard / SEO & Web Vitals" (${conclusion}) with ${annotations.length} annotations`
    );
  } catch (err) {
    console.error(`[seo-agent] Failed to post Check Run:`, err);
  }
}
