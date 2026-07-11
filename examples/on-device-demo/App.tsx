import React, {useCallback, useEffect, useState} from 'react';
import {
  Pressable,
  SafeAreaView,
  StatusBar,
  StyleSheet,
  Text,
  View,
} from 'react-native';

import {
  checkForUpdate,
  downloadUpdate,
  installUpdate,
  notifyAppReady,
  restartApp,
} from '@codemagic/react-native-patch';

// ---------------------------------------------------------------------------
// THIS is the line the walkthrough asks you to edit. Change 'v1' to 'v2',
// publish with `cmpatch release-react`, relaunch the app, and watch the
// banner flip — that's the OTA update applying.
// ---------------------------------------------------------------------------
const APP_VERSION = 'v1';

const BANNER_COLORS: Record<string, string> = {
  v1: '#1e6fd9',
  v2: '#1a9e63',
};

type Phase =
  | {kind: 'idle'}
  | {kind: 'checking'}
  | {kind: 'downloading'; percent: number | null}
  | {kind: 'installed'}
  | {kind: 'up-to-date'}
  | {kind: 'unreachable'; detail: string}
  | {kind: 'error'; detail: string};

function phaseLabel(phase: Phase): string {
  switch (phase.kind) {
    case 'idle':
      return 'Starting…';
    case 'checking':
      return 'Checking for updates…';
    case 'downloading':
      return phase.percent === null
        ? 'Downloading update…'
        : `Downloading update… ${phase.percent}%`;
    case 'installed':
      return 'Update installed.';
    case 'up-to-date':
      return `Up to date — you are running ${APP_VERSION}.`;
    case 'unreachable':
      return 'Local stack unreachable — is it running?\nStart it with: ./scripts/local-eval/up.sh';
    case 'error':
      return 'Update check failed.';
  }
}

function App(): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>({kind: 'idle'});

  const runUpdateFlow = useCallback(async () => {
    setPhase({kind: 'checking'});
    try {
      // Manual flow: notifyAppReady() confirms this launch as healthy before
      // we look for the next update (sync() would do the same internally).
      await notifyAppReady();
      const result = await checkForUpdate();

      if (result.action !== 'ota-update') {
        setPhase({kind: 'up-to-date'});
        return;
      }

      setPhase({kind: 'downloading', percent: null});
      const localPackage = await downloadUpdate(result.remotePackage, progress => {
        if (progress.totalBytes > 0) {
          setPhase({
            kind: 'downloading',
            percent: Math.round(
              (progress.receivedBytes / progress.totalBytes) * 100,
            ),
          });
        }
      });

      // Default install mode is ON_NEXT_RESTART: the update becomes pending
      // and boots on the next launch — the Relaunch button below triggers it.
      await installUpdate(localPackage);
      setPhase({kind: 'installed'});
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      // The most common first failure is simply "the evaluation stack is not
      // up" — say that instead of surfacing a bare network error.
      setPhase(
        /network|fetch|connect|refused|timed? ?out|unreachable/i.test(detail)
          ? {kind: 'unreachable', detail}
          : {kind: 'error', detail},
      );
    }
  }, []);

  useEffect(() => {
    void runUpdateFlow();
  }, [runUpdateFlow]);

  const bannerColor = BANNER_COLORS[APP_VERSION] ?? '#7a4fd0';
  const showDetail = phase.kind === 'unreachable' || phase.kind === 'error';

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="light-content" />
      <View style={[styles.banner, {backgroundColor: bannerColor}]}>
        <Text style={styles.bannerLabel}>Codemagic Patch demo</Text>
        <Text style={styles.bannerVersion}>{APP_VERSION}</Text>
      </View>
      <View style={styles.status}>
        <Text style={styles.statusText}>{phaseLabel(phase)}</Text>
        {showDetail ? (
          <Text style={styles.detailText}>{(phase as {detail: string}).detail}</Text>
        ) : null}
        {phase.kind === 'installed' ? (
          <Pressable
            style={styles.button}
            onPress={() => void restartApp()}
            accessibilityRole="button">
            <Text style={styles.buttonText}>Update installed — Relaunch</Text>
          </Pressable>
        ) : null}
        {phase.kind !== 'checking' && phase.kind !== 'downloading' ? (
          <Pressable
            style={[styles.button, styles.secondaryButton]}
            onPress={() => void runUpdateFlow()}
            accessibilityRole="button">
            <Text style={[styles.buttonText, styles.secondaryButtonText]}>
              Check again
            </Text>
          </Pressable>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: '#101418',
  },
  banner: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bannerLabel: {
    color: 'rgba(255, 255, 255, 0.8)',
    fontSize: 16,
    marginBottom: 8,
  },
  bannerVersion: {
    color: '#ffffff',
    fontSize: 96,
    fontWeight: '800',
  },
  status: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 24,
    gap: 16,
  },
  statusText: {
    color: '#e6ebf0',
    fontSize: 18,
    textAlign: 'center',
  },
  detailText: {
    color: '#8b97a3',
    fontSize: 13,
    textAlign: 'center',
  },
  button: {
    backgroundColor: '#1a9e63',
    borderRadius: 8,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderColor: '#3a4652',
    borderWidth: 1,
  },
  buttonText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: '600',
  },
  secondaryButtonText: {
    color: '#aab6c2',
  },
});

export default App;
