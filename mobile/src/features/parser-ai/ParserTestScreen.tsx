/**
 * ParserTestScreen.tsx — On-device LLM Pipeline Test Lab
 *
 * Full pipeline test: initExtractor → extract() (LLM w/ grammar decoding)
 * Also runs extractFallback() in parallel so you can compare quality.
 */

import React, { useState, useCallback, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  ScrollView,
  StyleSheet,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  initExtractorWithProgress,
  extract,
  extractFallback,
  isModelLoaded,
} from './kvParser';
import type { ExtractorProgress } from './kvParser';
import type { DocumentKV, DocType } from './types';

// -- Sample OCR snippets ---------------------------------------------------

const SAMPLES: { label: string; text: string }[] = [
  {
    label: '📄 Resume',
    text: `John Doe
Senior Software Engineer

Email: john.doe@example.com
Phone: +1 (555) 867-5309

Experience:
Software Engineer — Acme Corp (2020–2024)
  Built microservices, led a team of 5.

Education:
B.Sc. Computer Science — MIT, 2018

Skills: TypeScript, React Native, Python, SQL`,
  },
  {
    label: '🧾 Invoice',
    text: `INVOICE #1042
Date: 2024-08-01
Bill To: Jane Smith, 42 Elm Street, Springfield

Item               Qty   Unit Price   Total
Web Design          1      $2,500     $2,500
Hosting (annual)    1        $300       $300

Amount Due: $2,800
Due Date: 2024-09-01
Payment: Bank Transfer`,
  },
  {
    label: '🪪 ID Card',
    text: `NATIONAL ID CARD
Name: Arjun Kumar
Date of Birth: 15/03/1992
National ID: IND-2923-XXXX
Aadhaar: 1234 5678 9012
Address: 88 Nehru Nagar, Bengaluru - 560001
Valid Until: 2030-03-15`,
  },
  {
    label: '🎓 Cert',
    text: `Certificate of Completion
This certifies that Maria Lopez
has successfully completed Advanced Machine Learning
Awarded to: Maria Lopez
Date: 20 July 2024
Issued by: DeepLearn Academy`,
  },
  {
    label: '📋 Tax',
    text: `Form W-2 — Wage and Tax Statement 2023
Employer: Acme Corporation
EIN: 12-3456789
Employee: Robert Brown
SSN: XXX-XX-1234
Wages, tips: $95,000
Federal income tax withheld: $18,500`,
  },
];

const DOC_TYPE_COLORS: Record<DocType, string> = {
  resume: '#6C63FF',
  tax_form: '#E85D04',
  certificate: '#2EC4B6',
  invoice: '#F7B731',
  id_card: '#20BF55',
  letter: '#4ECDC4',
  other: '#8D99AE',
};

// -- Types for results -----------------------------------------------------

interface RunResult {
  llm: DocumentKV | null;
  llmMs: number | null;
  llmError: string | null;
  fallback: DocumentKV;
  fallbackMs: number;
}

// -- Main Component --------------------------------------------------------

export default function ParserTestScreen() {
  const insets = useSafeAreaInsets();
  const [ocrText, setOcrText] = useState('');
  const [modelProgress, setModelProgress] = useState<ExtractorProgress | null>(null);
  const [modelReady, setModelReady] = useState(isModelLoaded());
  const [loadingModel, setLoadingModel] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RunResult | null>(null);
  const [activeTab, setActiveTab] = useState<'llm' | 'fallback'>('llm');
  const [activeSample, setActiveSample] = useState<number | null>(null);

  // -- Load model ----------------------------------------------------------
  const handleLoadModel = useCallback(async () => {
    setLoadingModel(true);
    setModelProgress({ status: 'checking', downloadPct: 0, message: 'Starting…' });
    try {
      await initExtractorWithProgress(p => setModelProgress(p));
      setModelReady(true);
    } catch (err: any) {
      setModelProgress({
        status: 'error',
        downloadPct: 0,
        message: `Error: ${err?.message ?? String(err)}`,
      });
    } finally {
      setLoadingModel(false);
    }
  }, []);

  // -- Run pipeline --------------------------------------------------------
  const handleRun = useCallback(async () => {
    if (!ocrText.trim()) return;
    setRunning(true);
    setResult(null);

    // Fallback (sync, always works)
    const fbStart = Date.now();
    const fallback = extractFallback(ocrText);
    const fallbackMs = Date.now() - fbStart;

    // LLM path
    let llm: DocumentKV | null = null;
    let llmMs: number | null = null;
    let llmError: string | null = null;

    if (modelReady) {
      const llmStart = Date.now();
      try {
        llm = await extract(ocrText);
        llmMs = Date.now() - llmStart;
      } catch (err: any) {
        llmMs = Date.now() - llmStart;
        llmError = err?.message ?? String(err);
      }
    } else {
      llmError = 'Model not loaded — tap "Load Model" first';
    }

    setResult({ llm, llmMs, llmError, fallback, fallbackMs });
    setActiveTab(llm ? 'llm' : 'fallback');
    setRunning(false);
  }, [ocrText, modelReady]);

  const loadSample = useCallback((idx: number) => {
    setActiveSample(idx);
    setOcrText(SAMPLES[idx].text);
    setResult(null);
  }, []);

  const activeResult: DocumentKV | null =
    activeTab === 'llm' ? result?.llm ?? null : result?.fallback ?? null;
  const activeMs =
    activeTab === 'llm' ? result?.llmMs : result?.fallbackMs;

  return (
    <View style={[s.root, { paddingTop: insets.top }]}>
      {/* Header */}
      <View style={s.header}>
        <Text style={s.headerTitle}>🔬 Parser Pipeline Lab</Text>
        <Text style={s.headerSub}>LLM + Fallback  ·  Side-by-Side</Text>
      </View>

      <ScrollView
        style={s.scroll}
        contentContainerStyle={[s.scrollInner, { paddingBottom: insets.bottom + 24 }]}
        keyboardShouldPersistTaps="handled"
      >
        {/* Model status / load */}
        <View style={s.modelCard}>
          <View style={s.modelRow}>
            <View style={[s.dot, { backgroundColor: modelReady ? '#20BF55' : '#E85D04' }]} />
            <Text style={s.modelLabel}>
              {modelReady ? 'LFM2-350M loaded ✓' : 'Model not loaded'}
            </Text>
          </View>

          {modelProgress && !modelReady && (
            <View style={s.progressArea}>
              <Text style={s.progressMsg}>{modelProgress.message}</Text>
              {modelProgress.status === 'downloading' && (
                <View style={s.progressBar}>
                  <View style={[s.progressFill, { width: `${modelProgress.downloadPct}%` }]} />
                </View>
              )}
              {modelProgress.status === 'loading' && (
                <ActivityIndicator color={ACCENT} style={{ marginTop: 6 }} />
              )}
            </View>
          )}

          {!modelReady && (
            <TouchableOpacity
              style={[s.btn, s.btnAccent, loadingModel && s.btnDisabled]}
              onPress={handleLoadModel}
              disabled={loadingModel}
              activeOpacity={0.8}
            >
              {loadingModel ? (
                <ActivityIndicator color="#FFF" size="small" />
              ) : (
                <Text style={s.btnText}>⬇ Load Model (~200 MB)</Text>
              )}
            </TouchableOpacity>
          )}
        </View>

        {/* Samples */}
        <Text style={s.label}>QUICK SAMPLES</Text>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.chipsRow}>
          {SAMPLES.map((sm, i) => (
            <TouchableOpacity
              key={sm.label}
              style={[s.chip, activeSample === i && s.chipOn]}
              onPress={() => loadSample(i)}
              activeOpacity={0.7}
            >
              <Text style={[s.chipTxt, activeSample === i && s.chipTxtOn]}>{sm.label}</Text>
            </TouchableOpacity>
          ))}
        </ScrollView>

        {/* Input */}
        <Text style={s.label}>OCR TEXT</Text>
        <TextInput
          style={s.input}
          multiline
          placeholder="Paste raw OCR text here…"
          placeholderTextColor="#4A5568"
          value={ocrText}
          onChangeText={t => { setOcrText(t); setActiveSample(null); }}
          textAlignVertical="top"
          autoCapitalize="none"
          autoCorrect={false}
        />

        {/* Run */}
        <TouchableOpacity
          style={[s.btn, s.btnAccent, s.btnLg, (!ocrText.trim() || running) && s.btnDisabled]}
          onPress={handleRun}
          disabled={!ocrText.trim() || running}
          activeOpacity={0.8}
        >
          {running ? (
            <ActivityIndicator color="#FFF" size="small" />
          ) : (
            <Text style={s.btnText}>▶  Run Full Pipeline</Text>
          )}
        </TouchableOpacity>

        {/* Results */}
        {result && (
          <View style={s.resCard}>
            {/* Tab bar */}
            <View style={s.tabBar}>
              <TouchableOpacity
                style={[s.tab, activeTab === 'llm' && s.tabOn]}
                onPress={() => setActiveTab('llm')}
              >
                <Text style={[s.tabTxt, activeTab === 'llm' && s.tabTxtOn]}>
                  🤖 LLM {result.llmMs != null ? `(${result.llmMs}ms)` : ''}
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[s.tab, activeTab === 'fallback' && s.tabOn]}
                onPress={() => setActiveTab('fallback')}
              >
                <Text style={[s.tabTxt, activeTab === 'fallback' && s.tabTxtOn]}>
                  ⚙ Fallback ({result.fallbackMs}ms)
                </Text>
              </TouchableOpacity>
            </View>

            {/* Error */}
            {activeTab === 'llm' && result.llmError && (
              <View style={s.errBox}>
                <Text style={s.errTxt}>⚠ {result.llmError}</Text>
              </View>
            )}

            {/* Content */}
            {activeResult && <ResultView data={activeResult} />}
          </View>
        )}
      </ScrollView>
    </View>
  );
}

// -- Result sub-view -------------------------------------------------------

function ResultView({ data }: { data: DocumentKV }) {
  const [showJson, setShowJson] = useState(false);
  const badgeColor = DOC_TYPE_COLORS[data.doc_type] ?? '#8D99AE';

  return (
    <View>
      {/* Doc type badge */}
      <View style={[s.badge, { backgroundColor: badgeColor }]}>
        <Text style={s.badgeTxt}>{data.doc_type.replace('_', ' ').toUpperCase()}</Text>
      </View>

      {/* Fields */}
      <Text style={s.secLabel}>FIELDS ({data.fields.length})</Text>
      {data.fields.length === 0 ? (
        <Text style={s.empty}>No fields detected</Text>
      ) : (
        data.fields.map((f, i) => (
          <View key={i} style={[s.fRow, i % 2 === 0 && s.fRowAlt]}>
            <Text style={s.fKey}>{f.key}</Text>
            <Text style={s.fVal}>{f.value}</Text>
          </View>
        ))
      )}

      {/* Keywords */}
      <Text style={[s.secLabel, { marginTop: 14 }]}>KEYWORDS ({data.keywords.length})</Text>
      <View style={s.kwWrap}>
        {data.keywords.map((kw, i) => (
          <View key={i} style={s.kw}>
            <Text style={s.kwTxt}>{kw}</Text>
          </View>
        ))}
      </View>

      {/* Raw JSON toggle */}
      <TouchableOpacity style={s.jsonToggle} onPress={() => setShowJson(v => !v)}>
        <Text style={s.jsonToggleTxt}>{showJson ? '▲ Hide' : '▼ Show'} Raw JSON</Text>
      </TouchableOpacity>
      {showJson && (
        <ScrollView horizontal>
          <Text style={s.json}>{JSON.stringify(data, null, 2)}</Text>
        </ScrollView>
      )}
    </View>
  );
}

// -- Styles ----------------------------------------------------------------

const ACCENT = '#6C63FF';
const BG = '#0D0F14';
const CARD = '#161A23';
const CARD2 = '#1E2330';
const BORD = '#2A3045';
const TXT = '#E8EAF0';
const MUTED = '#6B7280';
const MONO = Platform.OS === 'ios' ? 'Menlo' : 'monospace';

const s = StyleSheet.create({
  root: { flex: 1, backgroundColor: BG },
  header: { paddingHorizontal: 20, paddingTop: 14, paddingBottom: 10, backgroundColor: CARD, borderBottomWidth: 1, borderBottomColor: BORD },
  headerTitle: { fontSize: 21, fontWeight: '700', color: TXT },
  headerSub: { fontSize: 11, color: MUTED, marginTop: 2, letterSpacing: 0.5 },
  scroll: { flex: 1 },
  scrollInner: { padding: 16 },

  // model card
  modelCard: { backgroundColor: CARD, borderRadius: 14, padding: 14, borderWidth: 1, borderColor: BORD, marginBottom: 8 },
  modelRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 8 },
  dot: { width: 8, height: 8, borderRadius: 4, marginRight: 8 },
  modelLabel: { color: TXT, fontSize: 13, fontWeight: '600' },
  progressArea: { marginBottom: 10 },
  progressMsg: { color: MUTED, fontSize: 12 },
  progressBar: { height: 6, backgroundColor: CARD2, borderRadius: 3, marginTop: 6, overflow: 'hidden' },
  progressFill: { height: 6, backgroundColor: ACCENT, borderRadius: 3 },

  // shared
  label: { fontSize: 10, fontWeight: '700', color: MUTED, letterSpacing: 1.3, marginTop: 14, marginBottom: 6 },
  btn: { borderRadius: 12, paddingVertical: 13, alignItems: 'center', justifyContent: 'center' },
  btnAccent: { backgroundColor: ACCENT },
  btnLg: { marginTop: 12 },
  btnDisabled: { opacity: 0.4 },
  btnText: { color: '#FFF', fontWeight: '700', fontSize: 14 },

  // chips
  chipsRow: { flexDirection: 'row', marginBottom: 4 },
  chip: { paddingHorizontal: 12, paddingVertical: 6, borderRadius: 18, backgroundColor: CARD2, borderWidth: 1, borderColor: BORD, marginRight: 7 },
  chipOn: { backgroundColor: ACCENT, borderColor: ACCENT },
  chipTxt: { color: MUTED, fontSize: 12, fontWeight: '500' },
  chipTxtOn: { color: '#FFF' },

  // input
  input: { backgroundColor: CARD, borderWidth: 1, borderColor: BORD, borderRadius: 12, padding: 12, color: TXT, fontSize: 12, minHeight: 140, fontFamily: MONO, lineHeight: 18 },

  // result card
  resCard: { backgroundColor: CARD, borderRadius: 16, padding: 14, marginTop: 16, borderWidth: 1, borderColor: BORD },
  tabBar: { flexDirection: 'row', gap: 6, marginBottom: 12 },
  tab: { flex: 1, paddingVertical: 9, borderRadius: 10, alignItems: 'center', backgroundColor: CARD2 },
  tabOn: { backgroundColor: ACCENT },
  tabTxt: { color: MUTED, fontSize: 12, fontWeight: '600' },
  tabTxtOn: { color: '#FFF' },

  errBox: { backgroundColor: '#3A1515', borderRadius: 8, padding: 10, marginBottom: 10 },
  errTxt: { color: '#FF6B6B', fontSize: 12 },

  badge: { alignSelf: 'flex-start', paddingHorizontal: 11, paddingVertical: 4, borderRadius: 7, marginBottom: 12 },
  badgeTxt: { color: '#FFF', fontSize: 11, fontWeight: '800', letterSpacing: 1.2 },

  secLabel: { fontSize: 10, fontWeight: '700', color: MUTED, letterSpacing: 1, marginBottom: 6 },
  empty: { color: MUTED, fontSize: 12, fontStyle: 'italic' },

  fRow: { flexDirection: 'row', paddingVertical: 7, paddingHorizontal: 8, borderRadius: 6, gap: 8 },
  fRowAlt: { backgroundColor: CARD2 },
  fKey: { width: '35%', color: ACCENT, fontSize: 11, fontWeight: '600', fontFamily: MONO },
  fVal: { flex: 1, color: TXT, fontSize: 12 },

  kwWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 5 },
  kw: { backgroundColor: CARD2, borderRadius: 5, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: BORD },
  kwTxt: { color: MUTED, fontSize: 10 },

  jsonToggle: { marginTop: 14 },
  jsonToggleTxt: { color: ACCENT, fontSize: 12, fontWeight: '600' },
  json: { color: '#A8B2CC', fontSize: 10, fontFamily: MONO, lineHeight: 16, paddingTop: 6 },
});
