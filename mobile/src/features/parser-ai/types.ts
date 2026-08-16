/**
 * Shared types for the PRISM parser-ai feature.
 * Defined per ISSUE-7-SPEC.md §2.
 */

// ---------------------------------------------------------------------------
// Document classification
// ---------------------------------------------------------------------------

export type DocType =
  | 'resume'
  | 'tax_form'
  | 'certificate'
  | 'invoice'
  | 'id_card'
  | 'letter'
  | 'other';

// ---------------------------------------------------------------------------
// KV structures
// ---------------------------------------------------------------------------

export interface KVField {
  /** Semantic key name, e.g. "issuer", "skills", "full_name" */
  key: string;
  value: string;
}

export interface DocumentKV {
  /**
   * Coarse document category — acts as the primary routing header at query
   * time before the pipeline inspects individual `fields`.
   */
  doc_type: DocType;
  /**
   * Flat key-value pairs; what SQLite / FTS5 actually indexes and searches.
   */
  fields: KVField[];
  /**
   * Free-text tag bag used as a fuzzy-search fallback when a query does not
   * match a specific field.
   */
  keywords: string[];
}

// ---------------------------------------------------------------------------
// PII sanitizer outputs
// ---------------------------------------------------------------------------

export interface SanitizeResult {
  /** Same shape as input fields, PII values replaced with surrogate tokens. */
  sanitizedFields: KVField[];
  /**
   * token → original value, e.g. "[NAME_1]" → "John Doe".
   * Lives in-memory only for the duration of one synthesis request.
   * Must NEVER be persisted to disk or sent over the network.
   */
  tokenMap: Map<string, string>;
}

export type PIICategory =
  | 'name'
  | 'email'
  | 'phone'
  | 'address'
  | 'government_id'
  | 'dob'
  | 'account_number';
