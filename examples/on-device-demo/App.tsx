import React, {useCallback, useEffect, useRef, useState} from 'react';
import {
  Alert,
  AppState,
  Pressable,
  SafeAreaView,
  ScrollView,
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
  sync,
  type InstallMode,
  type LocalPackage,
} from '@codemagic/react-native-patch';

// ---------------------------------------------------------------------------
// Demo toggles. Change values, then rebuild or publish an OTA.
// ---------------------------------------------------------------------------

// THIS is the line the walkthrough asks you to edit. Set CHECKOUT_BROKEN to
// false, publish with `cmpatch release-react`, relaunch the app, and Add to
// cart stops failing with the intentional bug.
const CHECKOUT_BROKEN = true;

/**
 * When the app looks for an update.
 * Options: "on-launch" | "on-resume" | "both"
 */
const CHECK_CONDITION: string = 'both';

/**
 * true  = show Later / Install Now after download
 * false = install with no confirm UI (uses sync())
 */
const INSTALL_CONFIRMATION = true;

/**
 * How the install is staged once it runs.
 * Options: "IMMEDIATE" | "ON_NEXT_RESTART" | "ON_NEXT_RESUME" | "ON_NEXT_SUSPEND"
 * IMMEDIATE reloads on its own; other modes call restartApp after install.
 */
const INSTALL_MODE: string = 'ON_NEXT_RESTART';

const PRODUCTS = [
  {
    id: 'box',
    name: 'Premium Cardboard Box',
    description: 'Perfect for cats to sit in.',
    price: '$99.99',
    emoji: '📦',
    badge: 'Best Seller',
    stars: 5,
  },
  {
    id: 'glow',
    name: 'Cool Glow Sticks',
    description: 'Shake vigorously. Do not eat. Results may vary.',
    price: '$29.99',
    emoji: '✨',
    badge: 'Hot',
    stars: 4,
  },
];

function shouldCheck(trigger: 'launch' | 'resume'): boolean {
  if (CHECK_CONDITION === 'both') {
    return true;
  }
  return CHECK_CONDITION === `on-${trigger}`;
}

async function applyInstalledUpdate() {
  if (INSTALL_MODE === 'IMMEDIATE') {
    return;
  }
  await restartApp(true);
}

async function installReadyPackage(localPackage: LocalPackage) {
  await installUpdate(localPackage, {
    installMode: INSTALL_MODE as InstallMode,
  });
  await applyInstalledUpdate();
}

function App(): React.JSX.Element {
  const readyPackage = useRef<LocalPackage | null>(null);
  const checking = useRef(false);
  const [updateReady, setUpdateReady] = useState(false);

  const runUpdateCheck = useCallback(async () => {
    if (checking.current) {
      return;
    }

    if (INSTALL_CONFIRMATION && readyPackage.current) {
      setUpdateReady(true);
      return;
    }

    checking.current = true;
    try {
      if (!INSTALL_CONFIRMATION) {
        const syncStatus = await sync({
          installMode: INSTALL_MODE as InstallMode,
        });
        if (syncStatus === 'update-installed') {
          await applyInstalledUpdate();
        }
        return;
      }

      const result = await checkForUpdate();
      if (result.action !== 'ota-update') {
        return;
      }

      readyPackage.current = await downloadUpdate(result.remotePackage);
      setUpdateReady(true);
    } catch {
      // Stay on the current bundle if check/download fails.
    } finally {
      checking.current = false;
    }
  }, []);

  useEffect(() => {
    // sync() confirms the launch internally; the manual path must do it here.
    if (INSTALL_CONFIRMATION) {
      void notifyAppReady();
    }

    if (shouldCheck('launch')) {
      void runUpdateCheck();
    }

    const subscription = AppState.addEventListener('change', state => {
      if (state === 'active' && shouldCheck('resume')) {
        void runUpdateCheck();
      }
    });

    return () => subscription.remove();
  }, [runUpdateCheck]);

  useEffect(() => {
    if (!updateReady || !INSTALL_CONFIRMATION) {
      return;
    }

    Alert.alert('Update Available', 'A new JS bundle is ready to install.', [
      {
        text: 'Later',
        style: 'cancel',
        onPress: () => setUpdateReady(false),
      },
      {
        text: 'Install Now',
        onPress: () => {
          void (async () => {
            const localPackage = readyPackage.current;
            if (!localPackage) {
              return;
            }
            try {
              await installReadyPackage(localPackage);
            } catch {
              Alert.alert('Install failed', 'Could not install the update.');
              setUpdateReady(false);
            }
          })();
        },
      },
    ]);
  }, [updateReady]);

  const onBuy = (productName: string) => {
    if (CHECKOUT_BROKEN) {
      Alert.alert('Payment failed', 'Error 418: intentional bug');
      return;
    }
    Alert.alert('Order confirmed', `Your ${productName} is on the way.`);
  };

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="dark-content" />
      <ScrollView contentContainerStyle={styles.scrollContent}>
        <View style={styles.promoBar}>
          <Text style={styles.promoText}>Demo store for OTA patch testing</Text>
        </View>

        <View style={styles.header}>
          <Text style={styles.title}>Convincing Demo Store</Text>
          <Text style={styles.subtitle}>Might plausibly sell something</Text>
        </View>

        <View style={styles.navBar}>
          {['Home', 'Products', 'About'].map(link => (
            <Text key={link} style={styles.navLink}>
              {link}
            </Text>
          ))}
        </View>

        <View style={styles.sectionHeader}>
          <Text style={styles.sectionTitle}>Featured products</Text>
        </View>

        <View style={styles.productGrid}>
          {PRODUCTS.map(product => (
            <View key={product.id} style={styles.productCard}>
              {product.badge ? (
                <View style={styles.badge}>
                  <Text style={styles.badgeText}>{product.badge}</Text>
                </View>
              ) : null}

              <View style={styles.productImage}>
                <Text style={styles.productEmoji}>{product.emoji}</Text>
              </View>

              <Text style={styles.productName}>{product.name}</Text>
              <Text style={styles.stars}>
                {'★'.repeat(product.stars)}
                {'☆'.repeat(5 - product.stars)}
              </Text>
              <Text style={styles.productDescription}>{product.description}</Text>
              <Text style={styles.price}>{product.price}</Text>

              <Pressable
                style={styles.buyButton}
                onPress={() => onBuy(product.name)}
                accessibilityRole="button">
                <Text style={styles.buyButtonText}>Add to cart</Text>
              </Pressable>
            </View>
          ))}
        </View>

        <Text style={styles.footer}>
          Secure checkout · Visa / Mastercard accepted
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#f5f5f5',
  },
  scrollContent: {
    paddingBottom: 24,
  },
  promoBar: {
    backgroundColor: '#111',
    paddingVertical: 10,
    paddingHorizontal: 16,
  },
  promoText: {
    color: '#fff',
    fontSize: 13,
    fontWeight: '500',
    textAlign: 'center',
  },
  header: {
    backgroundColor: '#fff',
    paddingVertical: 28,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
    alignItems: 'center',
  },
  title: {
    fontSize: 28,
    fontWeight: '700',
    color: '#111',
    letterSpacing: -0.3,
  },
  subtitle: {
    fontSize: 15,
    color: '#737373',
    marginTop: 6,
  },
  navBar: {
    flexDirection: 'row',
    justifyContent: 'center',
    gap: 24,
    backgroundColor: '#fff',
    paddingVertical: 12,
    borderBottomWidth: 1,
    borderBottomColor: '#e5e5e5',
  },
  navLink: {
    fontSize: 14,
    fontWeight: '500',
    color: '#525252',
  },
  sectionHeader: {
    paddingVertical: 20,
    paddingHorizontal: 20,
  },
  sectionTitle: {
    fontSize: 20,
    fontWeight: '600',
    color: '#111',
  },
  productGrid: {
    paddingHorizontal: 16,
    gap: 12,
  },
  productCard: {
    backgroundColor: '#fff',
    borderWidth: 1,
    borderColor: '#e5e5e5',
    borderRadius: 8,
    padding: 20,
    position: 'relative',
  },
  badge: {
    position: 'absolute',
    top: 16,
    right: 16,
    backgroundColor: '#111',
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 4,
  },
  badgeText: {
    color: '#fff',
    fontSize: 11,
    fontWeight: '600',
  },
  productImage: {
    width: 96,
    height: 96,
    backgroundColor: '#fafafa',
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 16,
    alignSelf: 'center',
  },
  productEmoji: {
    fontSize: 44,
  },
  productName: {
    fontSize: 17,
    fontWeight: '600',
    color: '#111',
    marginBottom: 4,
  },
  stars: {
    fontSize: 14,
    color: '#f59e0b',
    marginBottom: 8,
  },
  productDescription: {
    fontSize: 14,
    color: '#737373',
    lineHeight: 20,
    marginBottom: 12,
  },
  price: {
    fontSize: 22,
    fontWeight: '700',
    color: '#111',
    marginBottom: 16,
  },
  buyButton: {
    backgroundColor: '#111',
    paddingVertical: 14,
    borderRadius: 6,
    alignItems: 'center',
  },
  buyButtonText: {
    color: '#fff',
    fontSize: 15,
    fontWeight: '600',
  },
  footer: {
    marginTop: 24,
    paddingHorizontal: 20,
    textAlign: 'center',
    fontSize: 12,
    color: '#a3a3a3',
  },
});

export default App;
