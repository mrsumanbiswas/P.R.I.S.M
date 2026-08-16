/**
 * Fallback module-level mock for llama.rn.
 *
 * Jest's moduleNameMapper points here so that imports resolve without trying
 * to load the native JSI binary in the Node test environment.
 *
 * Individual test files that need fine-grained control use jest.mock('llama.rn', ...)
 * which hoists and replaces this stub entirely.
 */
const mockCompletion = jest.fn().mockResolvedValue({ text: '{}' });
const mockCtx = { completion: mockCompletion };

const llamaRnMock = {
  convertJsonSchemaToGrammar: jest.fn(() => '__MOCK_GRAMMAR__'),
  initLlama: jest.fn().mockResolvedValue(mockCtx),
  /** Exposed so per-test files can reach the spy without re-requiring. */
  __mockCompletion: mockCompletion,
  __mockCtx: mockCtx,
};

export default llamaRnMock;

export const { convertJsonSchemaToGrammar, initLlama } = llamaRnMock;
