/**
 * kvParser.ts — Dynamic KV Extraction Engine
 *
 * Extracts structured key-value data from raw OCR text using an on-device
 * LLM (LiquidAI/LFM2-350M-Extract, Q4_0 GGUF) via llama.rn.
 *
 * Grammar-constrained decoding (JSON schema → GBNF) ensures `extract()` can
 * never return malformed JSON.  A regex/heuristic fallback guarantees the
 * pipeline never hard-fails, even on low-RAM devices.
 *
 * Spec reference: ISSUE-7-SPEC.md §3
 */

import { initLlama, convertJsonSchemaToGrammar } from 'llama.rn';
import type { LlamaContext } from 'llama.rn';
import RNFS from 'react-native-fs';
import type { DocType, DocumentKV, KVField } from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hugging Face download URL for the Q4_0 GGUF variant. */
const MODEL_URL =
  'https://huggingface.co/LiquidAI/LFM2-350M-Extract-GGUF/resolve/main/LFM2-350M-Extract-Q4_0.gguf';

const MODEL_FILENAME = 'LFM2-350M-Extract-Q4_0.gguf';

/** On-device path; model is cached here after the first download. */
const MODEL_PATH = `${RNFS.DocumentDirectoryPath}/${MODEL_FILENAME}`;

/** Maximum context window used when loading the model. */
const N_CTX = 2048;

/** Hard inference timeout in milliseconds (spec: 5 s ceiling on-device). */
const INFERENCE_TIMEOUT_MS = 5_000;

/** Maximum tokens the model is allowed to generate per call. */
const MAX_TOKENS = 512;

// ---------------------------------------------------------------------------
// JSON Schema enforced at the grammar layer
// ---------------------------------------------------------------------------

const DOC_TYPE_VALUES: DocType[] = [
  'resume',
  'tax_form',
  'certificate',
  'invoice',
  'id_card',
  'letter',
  'other',
];

/**
 * JSON Schema that describes DocumentKV exactly.
 * Passed to `convertJsonSchemaToGrammar` so llama.cpp hard-constrains every
 * token the model emits — malformed output is structurally impossible.
 */
const DOCUMENT_KV_SCHEMA = {
  type: 'object',
  properties: {
    doc_type: {
      type: 'string',
      enum: DOC_TYPE_VALUES,
    },
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          value: { type: 'string' },
        },
        required: ['key', 'value'],
      },
    },
    keywords: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['doc_type', 'fields', 'keywords'],
};

/**
 * GBNF grammar derived from the JSON schema above.
 * Computed once at module load — avoids re-conversion on every `extract()`.
 */
const DOCUMENT_KV_GRAMMAR: string = convertJsonSchemaToGrammar({
  schema: DOCUMENT_KV_SCHEMA,
  propOrder: { doc_type: 0, fields: 1, keywords: 2 },
});

// ---------------------------------------------------------------------------
// Shared llama.rn context (singleton)
// ---------------------------------------------------------------------------

let _llamaCtx: LlamaContext | null = null;

// ---------------------------------------------------------------------------
// Model download helper
// ---------------------------------------------------------------------------

/**
 * Downloads the GGUF model to app document storage on first run.
 * No-ops if the file already exists (model is cached across launches).
 */
async function ensureModelDownloaded(): Promise<void> {
  const exists = await RNFS.exists(MODEL_PATH);
  if (exists) {
    return;
  }

  console.log('[kvParser] Downloading LFM2-350M model …');
  const { promise } = RNFS.downloadFile({
    fromUrl: MODEL_URL,
    toFile: MODEL_PATH,
    progress: res => {
      const pct = ((res.bytesWritten / res.contentLength) * 100).toFixed(1);
      console.log(`[kvParser] Download progress: ${pct}%`);
    },
  });
  await promise;
  console.log('[kvParser] Model download complete:', MODEL_PATH);
}

// ---------------------------------------------------------------------------
// Progress callback types (for UI consumption)
// ---------------------------------------------------------------------------

export type ExtractorStatus =
  | 'checking'
  | 'downloading'
  | 'loading'
  | 'ready'
  | 'error';

export interface ExtractorProgress {
  status: ExtractorStatus;
  /** 0–100, only meaningful during 'downloading' */
  downloadPct: number;
  /** Human-readable status message */
  message: string;
}

/** On-device model path — exported for diagnostics display. */
export { MODEL_PATH };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Initialises the on-device LFM2-350M-Extract model context.
 *
 * Call once at app startup (or lazily on first document upload).
 * Downloads the GGUF file to app document storage on the very first run if it
 * is not already cached (~200 MB; not bundled in the APK).
 *
 * Subsequent calls are safe no-ops — the singleton context is reused.
 *
 * @throws if model download or llama.rn initialisation fails
 */
export async function initExtractor(): Promise<void> {
  if (_llamaCtx !== null) {
    return; // already initialised
  }

  await ensureModelDownloaded();

  console.log('[kvParser] Loading LFM2-350M model context …');
  _llamaCtx = await initLlama({
    model: MODEL_PATH,
    n_ctx: N_CTX,
  });
  console.log('[kvParser] Model context ready.');
}

/**
 * Same as `initExtractor()`, but pushes status updates through a callback
 * so the UI can render download progress, loading state, etc.
 */
export async function initExtractorWithProgress(
  onProgress: (p: ExtractorProgress) => void,
): Promise<void> {
  if (_llamaCtx !== null) {
    onProgress({ status: 'ready', downloadPct: 100, message: 'Model already loaded' });
    return;
  }

  // 1. Check if model file exists
  onProgress({ status: 'checking', downloadPct: 0, message: 'Checking for cached model…' });
  const exists = await RNFS.exists(MODEL_PATH);

  // 2. Download if needed
  if (!exists) {
    onProgress({ status: 'downloading', downloadPct: 0, message: 'Starting download…' });
    const { promise } = RNFS.downloadFile({
      fromUrl: MODEL_URL,
      toFile: MODEL_PATH,
      progress: res => {
        const pct = Math.round((res.bytesWritten / res.contentLength) * 100);
        onProgress({
          status: 'downloading',
          downloadPct: pct,
          message: `Downloading… ${pct}%  (${(res.bytesWritten / 1e6).toFixed(1)} MB)`,
        });
      },
    });
    await promise;
  }

  // 3. Load model context
  onProgress({ status: 'loading', downloadPct: 100, message: 'Loading model into memory…' });
  _llamaCtx = await initLlama({
    model: MODEL_PATH,
    n_ctx: N_CTX,
  });

  onProgress({ status: 'ready', downloadPct: 100, message: 'Model ready ✓' });
}

/** Returns true if the LLM model context is currently loaded. */
export function isModelLoaded(): boolean {
  return _llamaCtx !== null;
}

/**
 * Extracts structured KV data from raw OCR text using the on-device model.
 *
 * Output is grammar-constrained to match the `DocumentKV` schema — the model
 * cannot emit malformed JSON.
 *
 * Falls back to `extractFallback()` automatically if:
 *   - The model context has not been initialised (model load failure)
 *   - Inference exceeds the 5 s timeout
 *
 * @param rawText Full OCR output for one document
 * @returns Promise<DocumentKV> — never throws on malformed model output;
 *          throws only on a model load / inference infrastructure failure
 *          that the caller must handle
 */
export async function extract(rawText: string): Promise<DocumentKV> {
  // Guard: empty / garbage input
  if (!rawText || rawText.trim().length === 0) {
    return { doc_type: 'other', fields: [], keywords: [] };
  }

  // Guard: model not loaded — use fallback
  if (_llamaCtx === null) {
    console.warn(
      '[kvParser] Model context not initialised; using extractFallback()',
    );
    return extractFallback(rawText);
  }

  const prompt = buildExtractionPrompt(rawText);

  // Race inference against the 5 s timeout
  let result: string;
  try {
    result = await Promise.race([
      runInference(prompt),
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error('Inference timeout')),
          INFERENCE_TIMEOUT_MS,
        ),
      ),
    ]);
  } catch (err) {
    console.warn('[kvParser] Inference failed or timed out:', err);
    return extractFallback(rawText);
  }

  // Grammar-constrained output should always parse, but be defensive
  try {
    const parsed = JSON.parse(result) as DocumentKV;
    return sanitiseParsedOutput(parsed);
  } catch (parseErr) {
    // Should never happen with grammar-constrained decoding, but log for
    // diagnostics and degrade gracefully
    console.error(
      '[kvParser] Unexpected JSON parse failure (grammar bug?):', parseErr,
      '\nRaw output:', result,
    );
    return extractFallback(rawText);
  }
}

/**
 * Regex / heuristic fallback path.
 *
 * Used automatically by `extract()` when the model is unavailable or times
 * out, and exported so callers can force-use it (e.g. in tests that mock the
 * model away).
 *
 * Quality is lower than the LLM path, but the pipeline never hard-fails.
 *
 * @param rawText Full OCR output for one document
 * @returns DocumentKV — always returns a valid, schema-conformant object
 */
export function extractFallback(rawText: string): DocumentKV {
  if (!rawText || rawText.trim().length === 0) {
    return { doc_type: 'other', fields: [], keywords: [] };
  }

  const fields: KVField[] = [];

  // ------------------------------------------------------------------
  // 1. Detect doc_type via keyword heuristics
  // ------------------------------------------------------------------
  const lower = rawText.toLowerCase();
  const docType = detectDocType(lower);

  // ------------------------------------------------------------------
  // 2. Extract KV pairs via colon-delimited line heuristics
  // ------------------------------------------------------------------
  // Pattern: "Label: Value" (handles tabs, multiple spaces, optional trailing
  // period from OCR artefacts)
  const kvLineRegex = /^([A-Za-z][A-Za-z0-9 _/-]{1,40})[:\t]+(.{1,300})$/gm;
  let match: RegExpExecArray | null;
  while ((match = kvLineRegex.exec(rawText)) !== null) {
    const key = normaliseKey(match[1]);
    const value = match[2].trim().replace(/\.$/, '');
    if (key && value) {
      fields.push({ key, value });
    }
  }

  // ------------------------------------------------------------------
  // 3. Email addresses
  // ------------------------------------------------------------------
  const emails = extractEmails(rawText);
  emails.forEach(email => {
    if (!fields.some(f => f.value === email)) {
      fields.push({ key: 'email', value: email });
    }
  });

  // ------------------------------------------------------------------
  // 4. Phone numbers
  // ------------------------------------------------------------------
  const phones = extractPhones(rawText);
  phones.forEach(phone => {
    if (!fields.some(f => f.value === phone)) {
      fields.push({ key: 'phone', value: phone });
    }
  });

  // ------------------------------------------------------------------
  // 5. Keywords — significant words from the raw text
  // ------------------------------------------------------------------
  const keywords = extractKeywords(rawText, docType);

  return { doc_type: docType, fields, keywords };
}

// ---------------------------------------------------------------------------
// Private helpers — inference
// ---------------------------------------------------------------------------

async function runInference(prompt: string): Promise<string> {
  const ctx = _llamaCtx!;
  const result = await ctx.completion({
    prompt,
    grammar: DOCUMENT_KV_GRAMMAR,
    n_predict: MAX_TOKENS,
    stop: ['\n\n', '```'],
    temperature: 0.0, // deterministic for schema extraction
  });
  return (result.text ?? '').trim();
}

/**
 * Builds a clear, structured prompt that steers the small LFM2 model towards
 * outputting a valid DocumentKV JSON object.
 *
 * Few-shot examples are omitted intentionally — at Q4_0 quantisation the
 * extra context rarely improves accuracy and wastes precious token budget.
 */
function buildExtractionPrompt(rawText: string): string {
  // Truncate very long OCR text to stay comfortably within the 2048-token
  // context window (llama.cpp tokenises at ~3–4 chars per token on average).
  const truncated = rawText.slice(0, 3_500);

  return (
    'Extract structured information from the following document text.\n' +
    'Respond with a single JSON object matching this schema:\n' +
    '{"doc_type":"<one of: resume|tax_form|certificate|invoice|id_card|letter|other>",' +
    '"fields":[{"key":"<field name>","value":"<field value>"}],' +
    '"keywords":["<relevant keyword>"]}\n\n' +
    'Document text:\n' +
    '"""\n' +
    truncated +
    '\n"""\n\n' +
    'JSON output:'
  );
}

/**
 * Validates and normalises parsed model output so it always conforms to the
 * `DocumentKV` interface, even if the model introduces unexpected extra keys.
 */
function sanitiseParsedOutput(raw: unknown): DocumentKV {
  if (!raw || typeof raw !== 'object') {
    return { doc_type: 'other', fields: [], keywords: [] };
  }

  const r = raw as Record<string, unknown>;

  const docType: DocType = DOC_TYPE_VALUES.includes(r.doc_type as DocType)
    ? (r.doc_type as DocType)
    : 'other';

  const fields: KVField[] = Array.isArray(r.fields)
    ? r.fields
        .filter(
          (f): f is { key: string; value: string } =>
            f !== null &&
            typeof f === 'object' &&
            typeof (f as Record<string, unknown>).key === 'string' &&
            typeof (f as Record<string, unknown>).value === 'string',
        )
        .map(f => ({ key: f.key.trim(), value: f.value.trim() }))
        .filter(f => f.key.length > 0)
    : [];

  const keywords: string[] = Array.isArray(r.keywords)
    ? r.keywords.filter(k => typeof k === 'string').map(k => (k as string).trim()).filter(Boolean)
    : [];

  return { doc_type: docType, fields, keywords };
}

// ---------------------------------------------------------------------------
// Private helpers — fallback heuristics
// ---------------------------------------------------------------------------

function detectDocType(lower: string): DocType {
  if (
    /(resume|curriculum vitae|\bcv\b|work experience|skills summary)/.test(lower) ||
    // Common section headings that appear in resumes without the word "resume"
    (/\bexperience\b/.test(lower) && /\bskills\b/.test(lower)) ||
    (/\b(software|senior|junior|lead|staff)\s+\w+\s*\n/.test(lower) && /\bskills\b/.test(lower))
  ) {
    return 'resume';
  }
  if (/(tax (return|form|statement)|w-?2|1099|form 16|income tax)/.test(lower)) {
    return 'tax_form';
  }
  if (/(certificate of|this certifies|awarded to|certification)/.test(lower)) {
    return 'certificate';
  }
  if (/(invoice|bill to|amount due|purchase order|receipt)/.test(lower)) {
    return 'invoice';
  }
  if (/(passport|driving licen[cs]e|national id|id card|aadhaar|voter id)/.test(lower)) {
    return 'id_card';
  }
  if (/(dear |sincerely|yours faithfully|to whom it may concern)/.test(lower)) {
    return 'letter';
  }
  return 'other';
}

function normaliseKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_-]/g, '');
}

function extractEmails(text: string): string[] {
  const EMAIL_RE = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  return [...new Set(text.match(EMAIL_RE) ?? [])];
}

function extractPhones(text: string): string[] {
  // Matches international and local formats with common separators
  const PHONE_RE =
    /(?:\+?[1-9]\d{0,2}[\s\-.]?)?(?:\(?\d{2,4}\)?[\s\-.]?)?\d{3,4}[\s\-.]?\d{3,4}(?:[\s\-.]?\d{2,4})?/g;
  const candidates = text.match(PHONE_RE) ?? [];
  // Filter out strings that are clearly not phone numbers (too short, all zeros…)
  return [
    ...new Set(
      candidates
        .map(p => p.trim())
        .filter(p => {
          const digits = p.replace(/\D/g, '');
          return digits.length >= 7 && digits.length <= 15;
        }),
    ),
  ];
}

function extractKeywords(rawText: string, docType: DocType): string[] {
  // Start with the doc type itself as a guaranteed keyword
  const seed: string[] = [docType.replace('_', ' ')];

  // Capitalised words (names, institutions, places) — simple heuristic
  const CAPS_WORD_RE = /\b[A-Z][a-z]{2,}\b/g;
  const caps = rawText.match(CAPS_WORD_RE) ?? [];

  // Common document-relevant nouns
  const TOPIC_RE =
    /\b(education|experience|skills|employment|address|date|total|amount|name|issued|expires?|valid|department|company|university|college|school|position|title|salary|tax|certificate|diploma|degree|invoice|payment)\b/gi;
  const topics = (rawText.match(TOPIC_RE) ?? []).map(t => t.toLowerCase());

  const combined = [...seed, ...caps, ...topics];
  // Deduplicate, lowercase, max 20 keywords
  return [...new Set(combined.map(k => k.toLowerCase()))].slice(0, 20);
}
