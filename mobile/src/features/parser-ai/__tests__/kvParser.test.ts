/**
 * kvParser.test.ts
 *
 * Unit tests for kvParser.ts covering the Definition-of-Done checklist in
 * ISSUE-7-SPEC.md §5 (kvParser items only — piiSanitizer is a separate task).
 *
 * The llama.rn module and react-native-fs are mocked so these tests run
 * offline in Jest without a physical device or model file.
 */

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that reference the mocked
// modules so Jest can hoist them correctly.
// ---------------------------------------------------------------------------

/**
 * llama.rn mock — convertJsonSchemaToGrammar returns a sentinel string so we
 * can assert it is passed through without importing the native module.
 */
jest.mock('llama.rn', () => {
  const mockCompletion = jest.fn();
  const mockCtx = { completion: mockCompletion };

  return {
    convertJsonSchemaToGrammar: jest.fn(() => '__MOCK_GRAMMAR__'),
    initLlama: jest.fn().mockResolvedValue(mockCtx),
    __mockCompletion: mockCompletion, // exposed for per-test configuration
    __mockCtx: mockCtx,
  };
});

/**
 * react-native-fs mock — only the filesystem helpers used by kvParser.
 */
jest.mock('react-native-fs', () => ({
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn().mockResolvedValue(true), // model "already downloaded"
  downloadFile: jest.fn(() => ({ promise: Promise.resolve({ statusCode: 200 }) })),
}));

// ---------------------------------------------------------------------------
// Imports — after mocks are registered
// ---------------------------------------------------------------------------

import { initLlama, convertJsonSchemaToGrammar } from 'llama.rn';
import RNFS from 'react-native-fs';
import { extract, extractFallback, initExtractor } from '../kvParser';
import type { DocumentKV } from '../types';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Access the mocked `completion` function bound to the singleton context. */
const getMockCompletion = (): jest.MockedFunction<
  (params: object) => Promise<{ text: string }>
> => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (jest.requireMock('llama.rn') as any).__mockCompletion;
};

/**
 * Serialises a DocumentKV as the model output string so the parser can
 * JSON.parse it back — simulating grammar-constrained model output.
 */
const modelOutput = (kv: DocumentKV): string => JSON.stringify(kv);

/** Resets the singleton llama context between test suites that need it. */
async function resetExtractorState(): Promise<void> {
  // Force the module to re-evaluate _llamaCtx = null
  jest.resetModules();
}

// ---------------------------------------------------------------------------
// Sample document fixtures
// ---------------------------------------------------------------------------

const RESUME_TEXT = `
John Doe
Software Engineer

Email: john.doe@example.com
Phone: +1-555-0100
Address: 123 Main St, Springfield, IL 62701

EXPERIENCE
Company: Acme Corp
Position: Senior Developer
Duration: 2019 – 2024

SKILLS
JavaScript, TypeScript, React Native, Node.js

EDUCATION
University of Illinois — B.Sc. Computer Science, 2019
`.trim();

const TAX_FORM_TEXT = `
FORM W-2 — Wage and Tax Statement
Tax Year: 2024

Employee Name: Jane Smith
SSN: 123-45-6789
Employer: Global Corp Ltd
Federal Income Tax Withheld: $8,320.00
State: IL
`.trim();

const CERTIFICATE_TEXT = `
CERTIFICATE OF COMPLETION

This certifies that
Alice Johnson
has successfully completed the course
Advanced React Native Development

Issued by: TechAcademy Online
Date: 15 August 2025
`.trim();

const INVOICE_TEXT = `
Invoice #INV-2025-001
Bill To: Bob Martin
Company: Widgets Inc.
Date: 2025-07-01
Amount Due: $4,500.00
Payment Terms: Net 30
`.trim();

const EMPTY_TEXT = '';
const GARBAGE_TEXT = '   \t\n   \t   ';

// ---------------------------------------------------------------------------
// Test suite — extractFallback (no model required)
// ---------------------------------------------------------------------------

describe('extractFallback()', () => {
  // DoD: extractFallback produces a usable result when model path is disabled
  it('returns empty-safe DocumentKV for an empty string', () => {
    const result = extractFallback(EMPTY_TEXT);
    expect(result).toMatchObject<DocumentKV>({
      doc_type: 'other',
      fields: [],
      keywords: [],
    });
  });

  it('returns empty-safe DocumentKV for whitespace-only input', () => {
    const result = extractFallback(GARBAGE_TEXT);
    expect(result.doc_type).toBe('other');
    expect(result.fields).toHaveLength(0);
  });

  it('correctly classifies a resume', () => {
    const result = extractFallback(RESUME_TEXT);
    expect(result.doc_type).toBe('resume');
  });

  it('correctly classifies a tax form', () => {
    const result = extractFallback(TAX_FORM_TEXT);
    expect(result.doc_type).toBe('tax_form');
  });

  it('correctly classifies a certificate', () => {
    const result = extractFallback(CERTIFICATE_TEXT);
    expect(result.doc_type).toBe('certificate');
  });

  it('correctly classifies an invoice', () => {
    const result = extractFallback(INVOICE_TEXT);
    expect(result.doc_type).toBe('invoice');
  });

  it('extracts colon-delimited fields from a resume', () => {
    const result = extractFallback(RESUME_TEXT);
    const fieldKeys = result.fields.map(f => f.key);
    // At minimum these must be present
    expect(fieldKeys).toContain('email');
    expect(fieldKeys).toContain('phone');
  });

  it('extracts email addresses into fields', () => {
    const result = extractFallback(RESUME_TEXT);
    const emailField = result.fields.find(f => f.key === 'email');
    expect(emailField?.value).toBe('john.doe@example.com');
  });

  it('extracts phone numbers into fields', () => {
    const result = extractFallback(RESUME_TEXT);
    const phoneField = result.fields.find(f => f.key === 'phone');
    expect(phoneField).toBeDefined();
  });

  it('returns non-empty keywords for real documents', () => {
    const result = extractFallback(RESUME_TEXT);
    expect(result.keywords.length).toBeGreaterThan(0);
  });

  it('always returns schema-valid DocumentKV shape', () => {
    [RESUME_TEXT, TAX_FORM_TEXT, CERTIFICATE_TEXT, INVOICE_TEXT].forEach(text => {
      const result = extractFallback(text);
      expect(typeof result.doc_type).toBe('string');
      expect(Array.isArray(result.fields)).toBe(true);
      expect(Array.isArray(result.keywords)).toBe(true);
      result.fields.forEach(f => {
        expect(typeof f.key).toBe('string');
        expect(typeof f.value).toBe('string');
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Test suite — extract() with mocked model
// ---------------------------------------------------------------------------

describe('extract()', () => {
  beforeEach(async () => {
    // Reset mocks but keep module state intact between individual tests
    getMockCompletion().mockReset();
    // Re-initialise so _llamaCtx is populated
    await initExtractor();
  });

  // DoD: extract() on sample documents always returns schema-valid JSON
  it('returns schema-valid DocumentKV for a resume fixture', async () => {
    const expected: DocumentKV = {
      doc_type: 'resume',
      fields: [
        { key: 'full_name', value: 'John Doe' },
        { key: 'email', value: 'john.doe@example.com' },
      ],
      keywords: ['software', 'engineer', 'javascript'],
    };
    getMockCompletion().mockResolvedValueOnce({ text: modelOutput(expected) });

    const result = await extract(RESUME_TEXT);
    expect(result.doc_type).toBe('resume');
    expect(Array.isArray(result.fields)).toBe(true);
    expect(Array.isArray(result.keywords)).toBe(true);
    result.fields.forEach(f => {
      expect(typeof f.key).toBe('string');
      expect(typeof f.value).toBe('string');
    });
  });

  it('returns schema-valid DocumentKV for a tax form fixture', async () => {
    const expected: DocumentKV = {
      doc_type: 'tax_form',
      fields: [
        { key: 'employee_name', value: 'Jane Smith' },
        { key: 'tax_year', value: '2024' },
      ],
      keywords: ['w-2', 'wages', 'income'],
    };
    getMockCompletion().mockResolvedValueOnce({ text: modelOutput(expected) });

    const result = await extract(TAX_FORM_TEXT);
    expect(result.doc_type).toBe('tax_form');
  });

  it('returns schema-valid DocumentKV for a certificate fixture', async () => {
    const expected: DocumentKV = {
      doc_type: 'certificate',
      fields: [{ key: 'recipient', value: 'Alice Johnson' }],
      keywords: ['completion', 'react native'],
    };
    getMockCompletion().mockResolvedValueOnce({ text: modelOutput(expected) });

    const result = await extract(CERTIFICATE_TEXT);
    expect(result.doc_type).toBe('certificate');
  });

  it('returns schema-valid DocumentKV for an invoice fixture', async () => {
    const expected: DocumentKV = {
      doc_type: 'invoice',
      fields: [{ key: 'amount_due', value: '$4,500.00' }],
      keywords: ['invoice', 'payment'],
    };
    getMockCompletion().mockResolvedValueOnce({ text: modelOutput(expected) });

    const result = await extract(INVOICE_TEXT);
    expect(result.doc_type).toBe('invoice');
  });

  // DoD: malformed OCR (empty / garbage) → { doc_type: 'other', fields: [], keywords: [] }
  it('returns safe empty DocumentKV for empty input without calling the model', async () => {
    const result = await extract(EMPTY_TEXT);
    expect(result).toEqual({ doc_type: 'other', fields: [], keywords: [] });
    expect(getMockCompletion()).not.toHaveBeenCalled();
  });

  it('returns safe empty DocumentKV for whitespace-only input', async () => {
    const result = await extract(GARBAGE_TEXT);
    expect(result).toEqual({ doc_type: 'other', fields: [], keywords: [] });
    expect(getMockCompletion()).not.toHaveBeenCalled();
  });

  // DoD: grammar-constrained — never returns malformed JSON (the grammar
  // makes this impossible at runtime; here we verify the defensive JSON.parse
  // catch-branch falls back correctly in the improbable failure case)
  it('falls back to extractFallback when model returns unparseable text', async () => {
    getMockCompletion().mockResolvedValueOnce({ text: 'THIS IS NOT JSON' });

    const result = await extract(RESUME_TEXT);
    // Should still produce a valid DocumentKV via fallback
    expect(result.doc_type).toBeDefined();
    expect(Array.isArray(result.fields)).toBe(true);
    expect(Array.isArray(result.keywords)).toBe(true);
  });

  // DoD: graceful degradation when the pipeline falls back (model forcibly disabled)
  it('falls back gracefully when model times out', async () => {
    jest.useFakeTimers();

    getMockCompletion().mockImplementation(
      () => new Promise(resolve => setTimeout(() => resolve({ text: '{}' }), 10_000)),
    );

    const extractPromise = extract(RESUME_TEXT);
    jest.advanceTimersByTime(5_001);

    const result = await extractPromise;
    // Fallback must produce a valid result
    expect(result.doc_type).toBeDefined();
    expect(Array.isArray(result.fields)).toBe(true);

    jest.useRealTimers();
  });

  // Verify the grammar string is passed to context.completion
  it('passes the GBNF grammar to context.completion', async () => {
    const expected: DocumentKV = {
      doc_type: 'other',
      fields: [],
      keywords: [],
    };
    getMockCompletion().mockResolvedValueOnce({ text: modelOutput(expected) });

    await extract(RESUME_TEXT);

    expect(getMockCompletion()).toHaveBeenCalledWith(
      expect.objectContaining({ grammar: '__MOCK_GRAMMAR__' }),
    );
  });

  // Verify temperature is 0 (deterministic extraction)
  it('uses temperature=0 for deterministic extraction', async () => {
    const expected: DocumentKV = { doc_type: 'resume', fields: [], keywords: [] };
    getMockCompletion().mockResolvedValueOnce({ text: modelOutput(expected) });

    await extract(RESUME_TEXT);

    expect(getMockCompletion()).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0 }),
    );
  });
});

// ---------------------------------------------------------------------------
// Test suite — initExtractor()
// ---------------------------------------------------------------------------

describe('initExtractor()', () => {
  it('calls initLlama with the on-device model path', async () => {
    await initExtractor();
    expect(initLlama).toHaveBeenCalledWith(
      expect.objectContaining({
        model: '/mock/documents/LFM2-350M-Extract-Q4_0.gguf',
        n_ctx: 2048,
      }),
    );
  });

  it('downloads the model if it does not exist yet', async () => {
    // jest.isolateModulesAsync + dynamic import() requires --experimental-vm-modules.
    // Use jest.resetModules() + synchronous require() inside jest.isolateModules() instead.
    let downloadFileMock: jest.Mock | undefined;

    jest.resetModules();
    jest.isolateModules(() => {
      // Patch the RNFS mock before the module loads
      const rnfsMock = jest.requireMock('react-native-fs');
      (rnfsMock.exists as jest.Mock).mockReturnValueOnce(Promise.resolve(false));
      (rnfsMock.downloadFile as jest.Mock).mockClear();
      downloadFileMock = rnfsMock.downloadFile as jest.Mock;

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const freshParser = require('../kvParser');
      // Run async init (we use .then chaining since we can't await inside isolateModules)
      freshParser.initExtractor().then(() => { /* resolve */ }).catch(() => { /* ignore */ });
    });

    // Give the microtask queue time to process
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(downloadFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        toFile: '/mock/documents/LFM2-350M-Extract-Q4_0.gguf',
      }),
    );

    // Restore modules for subsequent tests
    jest.resetModules();
  });

  it('skips download when model file already exists', async () => {
    (RNFS.exists as jest.Mock).mockResolvedValueOnce(true);
    (RNFS.downloadFile as jest.Mock).mockClear();
    await initExtractor();
    expect(RNFS.downloadFile).not.toHaveBeenCalled();
  });

  it('convertJsonSchemaToGrammar is called at module load (grammar pre-computed)', () => {
    // convertJsonSchemaToGrammar is called when the module is first evaluated
    expect(convertJsonSchemaToGrammar).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Test suite — DoD: extractFallback as graceful degradation path
// ---------------------------------------------------------------------------

describe('extractFallback() — graceful degradation (DoD §5)', () => {
  it('produces a usable result for a resume when model path is forcibly disabled', () => {
    // Directly calling extractFallback simulates the model being unavailable
    const result = extractFallback(RESUME_TEXT);
    expect(result.doc_type).toBe('resume');
    expect(result.fields.length).toBeGreaterThan(0);
    expect(result.keywords.length).toBeGreaterThan(0);
  });

  it('produces a usable result for a tax form when model path is forcibly disabled', () => {
    const result = extractFallback(TAX_FORM_TEXT);
    expect(result.doc_type).toBe('tax_form');
    expect(result.fields.length).toBeGreaterThan(0);
  });

  it('produces a usable result for a certificate when model path is forcibly disabled', () => {
    const result = extractFallback(CERTIFICATE_TEXT);
    expect(result.doc_type).toBe('certificate');
  });

  it('always returns a valid DocumentKV (never throws)', () => {
    const edgeCases = [
      '', '   ', '\t\n', '???!!!', '1234567890',
      'a'.repeat(10_000), // extremely long text
    ];
    edgeCases.forEach(text => {
      expect(() => extractFallback(text)).not.toThrow();
      const result = extractFallback(text);
      expect(typeof result.doc_type).toBe('string');
      expect(Array.isArray(result.fields)).toBe(true);
      expect(Array.isArray(result.keywords)).toBe(true);
    });
  });
});
