# Issue #7 — Dynamic KV Extraction & PII Tokenizer/Sanitizer Engine

**Status:** Spec locked, ready for implementation
**Owner:** Sanjay-Sunil
**Location in monorepo:** `mobile/src/features/parser-ai/`
**Feeds into:** Issue #10 (Gemini Synthesis), Issue #11 (Full Pipeline Integration)

---

## 1. Where This Sits in the Pipeline

```
[Camera / File Picker]
        │
        ▼
[On-Device OCR]  (ML Kit / Apple Vision)
        │  raw_text: string
        ▼
┌───────────────────────────────────────────────┐
│  THIS ISSUE (#7)                               │
│                                                 │
│  raw_text ──► kvParser.extract() ──► DocumentKV│
│  raw_text ──► piiSanitizer.sanitize() ──►      │
│                  { sanitizedFields, tokenMap } │
└───────────────────────────────────────────────┘
        │                         │
        ▼                         ▼
[AES-256-GCM Encrypt]    [Stored in-memory only,
 (Issue #8)                per-session, never
        │                 persisted or sent]
        ▼
[SQLite KV/FTS5 Index]
        │
        ▼
   ... later, at query time ...
        │
        ▼
[User Prompt] ──► contextRouter (SQLite match, not
                   part of this issue) ──► relevant
                   DocumentKV records
        │
        ▼
[Decrypt matched docs in RAM]
        │
        ▼
piiSanitizer.sanitize() again on the *retrieved*
fields (fresh token map per request)
        │
        ▼
[Gemini synthesis — sees ONLY sanitized/tokenized data]
        │
        ▼
piiSanitizer.rehydrate() on the response
        │
        ▼
[Final rendered output to user]
```

**Key point for the integration engineer (#11):** `piiSanitizer` runs **twice** in the real
flow — once optionally at ingestion (if you want to store a pre-sanitized preview), and
always at query time right before anything touches the cloud LLM. Never send `fields[]`
to Gemini without running it through `sanitize()` first. Never persist a `tokenMap` to
disk — it lives only for the duration of one synthesis request and is discarded after
`rehydrate()` runs.

---

## 2. Shared Types

```typescript
// mobile/src/features/parser-ai/types.ts

export type DocType =
  | 'resume'
  | 'tax_form'
  | 'certificate'
  | 'invoice'
  | 'id_card'
  | 'letter'
  | 'other';

export interface KVField {
  key: string;    // e.g. "issuer", "skills", "full_name"
  value: string;
}

export interface DocumentKV {
  doc_type: DocType;
  fields: KVField[];
  keywords: string[];
}

export interface SanitizeResult {
  sanitizedFields: KVField[];   // same shape as input, PII values replaced with tokens
  tokenMap: Map<string, string>; // token -> original value, e.g. "[NAME_1]" -> "John Doe"
}

export type PIICategory =
  | 'name'
  | 'email'
  | 'phone'
  | 'address'
  | 'government_id'
  | 'dob'
  | 'account_number';
```

---

## 3. Module A — `kvParser.ts`

**Purpose:** Turn raw OCR text into structured, typed key-value data.

### Function Signatures

```typescript
/**
 * Initializes the on-device LFM2-350M-Extract model context.
 * Call once at app startup (or lazily on first document upload).
 * Downloads the GGUF model to app document storage on first run if not cached.
 */
export async function initExtractor(): Promise<void>;

/**
 * Extracts structured KV data from raw OCR text using the edge model.
 * Output is grammar-constrained to match the DocumentKV schema exactly —
 * the model cannot emit malformed JSON.
 *
 * @param rawText - Full OCR output for one document
 * @returns DocumentKV - never throws on malformed model output (schema-constrained);
 *          throws only on model load / inference failure
 */
export async function extract(rawText: string): Promise<DocumentKV>;

/**
 * Fallback path. Used automatically by extract() if the model fails to load
 * or inference times out (e.g. very low-RAM device). Regex/heuristic based.
 * Lower quality, but guarantees the pipeline never hard-fails.
 */
export function extractFallback(rawText: string): DocumentKV;
```

### Model Details
- Model: `LiquidAI/LFM2-350M-Extract` (GGUF, Q4_0 quantization)
- Runtime: `llama.rn` (React Native binding for llama.cpp)
- Load once via `initLlama({ model: path, n_ctx: 2048 })`, reuse context across documents
- Output constrained via JSON-schema grammar (see schema below) — this is what
  guarantees `extract()` never returns malformed JSON to the caller
- Model file is downloaded to app document storage on first launch, not bundled in the
  APK (~200MB — keeps install size sane)

### Enforced Output Schema

```json
{
  "doc_type": "resume | tax_form | certificate | invoice | id_card | letter | other",
  "fields": [
    { "key": "string", "value": "string" }
  ],
  "keywords": ["string"]
}
```

- `doc_type` — fixed enum, acts as the coarse relevance router (the "Header" concept).
  Query-time matching checks this first before inspecting `fields`.
- `fields` — flat KV pairs, what SQLite/FTS5 actually indexes and searches.
- `keywords` — free-text tag bag, fuzzy-search fallback for queries that don't match a
  specific field.

### Error Handling
- Model load failure → log, fall back to `extractFallback()`, never throw to caller
- Inference timeout (recommend 5s ceiling on-device) → same fallback path
- Malformed OCR input (empty string, garbage) → return `{ doc_type: 'other', fields: [], keywords: [] }`

---

## 4. Module B — `piiSanitizer.ts`

**Purpose:** Deterministically mask PII in structured KV data before it ever leaves the
device, and reverse that masking after the cloud LLM responds.

**Design decision (locked):** Masking operates on the *already-structured* `fields[]`
array (post-`kvParser`), not on raw free text, and does not use the LLM for the masking
decision itself. This is what makes `rehydrate()` byte-for-byte lossless and testable —
see rationale in section 6.

### Function Signatures

```typescript
/**
 * Scans a document's structured fields for PII and replaces values with
 * deterministic surrogate tokens. Same PII value appearing twice in one
 * document always maps to the same token.
 *
 * @param fields - Structured KV fields, typically from kvParser.extract().fields
 * @returns sanitizedFields (same shape, PII values replaced) + tokenMap
 */
export function sanitize(fields: KVField[]): SanitizeResult;

/**
 * Reverses sanitize() on a block of generated text (e.g. an LLM response),
 * swapping every token back to its original value.
 * Pure string replacement — no model, no heuristics, guaranteed exact.
 *
 * @param sanitizedText - Text containing tokens like [NAME_1], [EMAIL_1]
 * @param tokenMap - The map returned by sanitize() for this request
 * @returns Original text with all tokens replaced by real values
 */
export function rehydrate(sanitizedText: string, tokenMap: Map<string, string>): string;

/**
 * Internal: classifies whether a field key belongs to a PII category,
 * based on the taxonomy list (fuzzy match on common key-name variants).
 */
function classifyKey(key: string): PIICategory | null;

/**
 * Internal: regex backstop. Runs on every field value regardless of key name,
 * to catch PII sitting under an unexpected/generic key (e.g. "note").
 */
function detectByPattern(value: string): PIICategory | null;
```

### PII Key Taxonomy (fuzzy-matched against `field.key`)

| Category | Example key names matched |
|---|---|
| `name` | name, full_name, applicant, holder, candidate |
| `email` | email, e-mail, contact_email |
| `phone` | phone, mobile, contact_number, tel |
| `address` | address, residence, mailing_address |
| `government_id` | ssn, id_number, passport_no, aadhaar, license_no |
| `dob` | dob, date_of_birth, birthdate |
| `account_number` | account_no, iban, routing_number |

### Regex Backstop Patterns
- Email: standard RFC-lite email regex
- Phone: international-friendly digit/format pattern
- Government ID: configurable per-country pattern set (start with a generic
  8-12 digit alphanumeric pattern, refine per demo document set)

### Token Format
- `[CATEGORY_N]` — e.g. `[NAME_1]`, `[EMAIL_1]`, `[ID_1]`
- Counter increments per category, per sanitize() call (i.e. resets each request —
  tokens are not globally unique across documents, only within one synthesis call)
- Deduping: if the same original value appears twice within one `sanitize()` call,
  reuse the same token rather than incrementing

### Error Handling
- `sanitize()` never throws — worst case, a field is left unmasked and unit tests should
  catch that in CI, not at runtime
- `rehydrate()` on a token with no matching map entry → leave the token string as-is
  (visible failure is safer than silently dropping data)

---

## 5. Testing Requirements (Definition of Done)

- [ ] `sanitize()` on a fixture set covering every taxonomy category → 100% of known PII
      values replaced, zero raw PII strings present in `sanitizedFields`
- [ ] `rehydrate(sanitize(fields).sanitizedFields, tokenMap)` reconstructs the exact
      original values, byte-for-byte, for every field
- [ ] Same PII value repeated twice in one document → same token both times (not
      `[NAME_1]` and `[NAME_2]`)
- [ ] PII under an unexpected key name (e.g. `"note": "call John at 555-1234"`) is still
      caught by the regex backstop
- [ ] `extract()` on 3-5 sample documents (resume, tax form, certificate) always returns
      schema-valid JSON — this should never fail given grammar-constrained decoding
- [ ] `extractFallback()` produces a usable (if lower-quality) result when the model path
      is forcibly disabled, confirming the pipeline degrades gracefully

---

## 6. Why This Design (context for reviewers / judges Q&A)

- **Masking structured fields instead of free text** makes `rehydrate()` a pure string
  swap with no risk of the LLM paraphrasing or dropping content mid-mask — which would
  break exact reconstruction. This directly satisfies the "zero leakage and exact
  re-hydration match" requirement in the issue's Definition of Done.
- **Grammar-constrained extraction** (JSON schema enforced at the model layer, not
  parsed-and-hope after the fact) means `kvParser.extract()` cannot return malformed
  output during a live demo.
- **`doc_type` as a fixed enum** rather than a freeform header string keeps the
  query-routing layer (built separately, feeds Issue #11) deterministic — exact-match
  on a known set of categories, not fuzzy-matching arbitrary model-invented strings.

---

## 7. File Checklist

```
mobile/src/features/parser-ai/
├── types.ts            # shared interfaces (section 2)
├── kvParser.ts          # section 3
├── piiSanitizer.ts       # section 4
└── __tests__/
    ├── kvParser.test.ts
    └── piiSanitizer.test.ts
```
