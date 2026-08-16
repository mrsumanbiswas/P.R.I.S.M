module.exports = {
  preset: '@react-native/jest-preset',
  testMatch: ['**/__tests__/**/*.test.(ts|tsx)', '**/*.test.(ts|tsx)'],
  // Allow Jest to discover tests nested inside src/
  roots: ['<rootDir>/__tests__', '<rootDir>/src'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json'],
  // Map native modules that require JSI / device binaries to their mocks.
  // The actual mocks live inside each test file via jest.mock().
  moduleNameMapper: {
    // llama.rn ships with JSI bindings that cannot load in Node; let Jest
    // find the package but the test file overrides it with jest.mock().
    '^llama\\.rn$': '<rootDir>/src/features/parser-ai/__mocks__/llama.rn.ts',
    '^react-native-fs$':
      '<rootDir>/src/features/parser-ai/__mocks__/react-native-fs.ts',
  },
  transformIgnorePatterns: [
    // Transform llama.rn and react-native-fs source (they ship ESM/TS)
    'node_modules/(?!(llama\\.rn|react-native-fs|@react-native|react-native)/)',
  ],
};
