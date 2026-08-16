/**
 * App.tsx — PRISM Mobile
 *
 * Temporarily wired to ParserTestScreen for on-device LLM pipeline testing.
 * Swap back to your main navigator once testing is complete.
 *
 * @format
 */

import React from 'react';
import { StatusBar } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import ParserTestScreen from './src/features/parser-ai/ParserTestScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar barStyle="light-content" backgroundColor="#0D0F14" />
      <ParserTestScreen />
    </SafeAreaProvider>
  );
}
