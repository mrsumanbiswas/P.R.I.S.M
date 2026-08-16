/**
 * Fallback module-level mock for react-native-fs.
 *
 * Satisfies imports in the Node test environment without requiring the native
 * module. Individual test files can override specific methods via
 * jest.mock('react-native-fs', ...) or (RNFS.exists as jest.Mock).mockResolvedValueOnce(...).
 */
const RNFS = {
  DocumentDirectoryPath: '/mock/documents',
  exists: jest.fn().mockResolvedValue(true),
  downloadFile: jest.fn(() => ({
    promise: Promise.resolve({ statusCode: 200 }),
  })),
  readFile: jest.fn().mockResolvedValue(''),
  writeFile: jest.fn().mockResolvedValue(undefined),
  unlink: jest.fn().mockResolvedValue(undefined),
  mkdir: jest.fn().mockResolvedValue(undefined),
};

export default RNFS;
