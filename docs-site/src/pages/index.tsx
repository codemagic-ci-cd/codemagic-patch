import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import HomeTerminal from '@site/src/components/HomeTerminal';

import styles from './index.module.css';

const OTA_REASONS = [
  {
    title: 'No review wait',
    description:
      "Ship JS and asset updates directly to users' devices.",
  },
  {
    title: 'Controlled rollouts',
    description:
      'Release to a slice of users first. Expand the rollout when metrics look good.',
  },
  {
    title: 'Instant rollbacks',
    description:
      'Revert a bad release from the dashboard or CLI — no new store build required.',
  },
] as const;

const SYNC_COMMAND = `void sync({
  installMode: "ON_NEXT_SUSPEND",
  minimumBackgroundDuration: 60_000,
});`;

const MANIFEST_PATHS = `# SDK fetches manifests from storage/CDN — not the API
https://storage.updates.example.com/codemagic-patch/Production/meta.json
https://storage.updates.example.com/codemagic-patch/Production/1.0.0/manifest.json`;

const LOCAL_EVAL_COMMAND = `git clone https://github.com/codemagic-ci-cd/codemagic-patch.git
cd codemagic-patch
./scripts/local-eval/up.sh`;

const SECTIONS = [
  {
    title: 'Invisible updates',
    description:
      'Minimal download sizes and background install modes mean updates without interruptions.',
    bullets: [
      'Binary diffs mean users only download the required code changes.',
      'Options to download and install updates while the app is in the background',
      'Critical updates can be wired to user approval buttons',
    ],
    link: '/docs/setup/applying-updates',
    linkLabel: 'Install modes',
    reverse: false,
    media: 'terminal' as const,
    terminalLabel: 'sync',
    terminalContent: SYNC_COMMAND,
  },
  {
    title: 'Reliable delivery',
    description:
      'Both checks and downloads can live on the CDN, so updates keep flowing even when the server is down.',
    bullets: [
      "Checks and downloads don't hit the server",
      'Cache and scale at the edge',
      'Metrics report back separately',
    ],
    link: '/docs/using-patch/delivery',
    linkLabel: 'How delivery works',
    reverse: true,
    media: 'terminal' as const,
    terminalLabel: 'manifest',
    terminalContent: MANIFEST_PATHS,
  },
  {
    title: 'Publish and monitor releases',
    description:
      'Everything you need to publish, monitor, and control releases in production.',
    bullets: [
      'Web dashboard for releases, metrics, and team access',
      'Native fingerprinting so bundles only reach compatible binaries',
      'cmpatch CLI for CI; SDK with Expo config plugin',
    ],
    link: '/docs/using-patch/dashboard',
    linkLabel: 'Web dashboard',
    reverse: true,
    media: 'image' as const,
    imageAlt:
      'Codemagic Patch web dashboard showing deployment metrics and release history',
  },
  {
    title: 'Run it yourself',
    description:
      'Try the full stack on your laptop, then self-host when you leave localhost.',
    bullets: [
      'One-command local evaluation: server, dashboard, Postgres, MinIO',
      'On-device demo to watch an OTA apply on simulator or emulator',
      'Same Compose building blocks for production self-host with TLS and GitHub OAuth',
    ],
    link: '/docs/',
    linkLabel: 'Quickstart',
    reverse: false,
    media: 'terminal' as const,
    terminalLabel: 'local-eval',
    terminalContent: LOCAL_EVAL_COMMAND,
  },
] as const;

function FeatureCopy({
  title,
  description,
  bullets,
  link,
  linkLabel,
  id,
}: {
  title: string;
  description: string;
  bullets: readonly string[];
  link: string;
  linkLabel: string;
  id: string;
}): ReactNode {
  return (
    <div className={styles.featureCopy}>
      <h3 id={id}>{title}</h3>
      <p className={styles.featureDescription}>{description}</p>
      <ul className={styles.featureBullets}>
        {bullets.map((bullet) => (
          <li key={bullet}>{bullet}</li>
        ))}
      </ul>
      <Link className={styles.featureLink} to={link}>
        {linkLabel} →
      </Link>
    </div>
  );
}

export default function Home(): ReactNode {
  const dashboardSrc = useBaseUrl('/img/dashboard.png');

  return (
    <Layout
      title="Codemagic Patch"
      description="Self-hosted over-the-air updates for React Native, with server, SDK, CLI, and dashboard.">
      <main className={styles.page}>
        <header className={styles.hero}>
          <div className={styles.heroInner}>
            <h1 className={styles.title}>Codemagic Patch</h1>
            <p className={styles.lead}>
              Self-hosted over-the-air updates for React Native with dashboard and fingerprinting, all in one Compose.
            </p>
            <div className={styles.actions}>
              <Link className={styles.primaryButton} to="/docs/">
                Try locally
              </Link>
              <Link className={styles.secondaryButton} to="/docs/setup/self-host">
                Self-host guide
              </Link>
            </div>
          </div>
        </header>

        <section className={styles.whySection} aria-labelledby="home-why-ota">
          <div className={styles.whyInner}>
            <h2 id="home-why-ota">Why use OTA updates</h2>
            <p className={styles.whyLead}>
              Push JavaScript and bundled assets to installed apps without
              waiting on a full store release every time.
            </p>
            <div className={styles.whyGrid}>
              {OTA_REASONS.map((reason) => (
                <article key={reason.title} className={styles.whyCard}>
                  <h3>{reason.title}</h3>
                  <p>{reason.description}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        <div className={styles.sectionHeading}>
          <h2 id="home-why-patch">Why use Patch for your OTA updates</h2>
          <p className={styles.sectionHeadingLead}>
            Invisible installs, reliable deliveries and release dashboard all in a complete Docker Compose.
          </p>
        </div>

        {SECTIONS.map((section, index) => (
          <section
            key={section.title}
            className={styles.featureSection}
            aria-labelledby={`home-${index}`}>
            <div className={styles.featureInner}>
              <div
                className={
                  section.reverse
                    ? `${styles.featureRow} ${styles.featureRowReverse}`
                    : styles.featureRow
                }>
                <FeatureCopy
                  id={`home-${index}`}
                  title={section.title}
                  description={section.description}
                  bullets={section.bullets}
                  link={section.link}
                  linkLabel={section.linkLabel}
                />
                <div className={styles.featureMedia}>
                  {section.media === 'terminal' ? (
                    <HomeTerminal label={section.terminalLabel}>
                      {section.terminalContent}
                    </HomeTerminal>
                  ) : (
                    <img
                      className={styles.featureImage}
                      src={dashboardSrc}
                      alt={section.imageAlt}
                      loading="lazy"
                    />
                  )}
                </div>
              </div>
            </div>
          </section>
        ))}

        <section
          className={styles.comparisonSection}
          aria-labelledby="home-comparison">
          <div className={styles.comparisonInner}>
            <h2 id="home-comparison">How Patch compares</h2>
            <p className={styles.comparisonLead}>
              Patch, Expo Updates, and Hot Updater all ship JS updates to installed
              apps. They differ in hosting, ops, and how much you assemble
              yourself.
            </p>
            <div className={clsx(styles.comparisonTableWrap, 'markdown')}>
              <table>
                <colgroup>
                  <col className={styles.comparisonLabelCol} />
                  <col />
                  <col />
                  <col />
                </colgroup>
                <thead>
                  <tr>
                    <th scope="col" />
                    <th scope="col">Expo Updates</th>
                    <th scope="col">Hot Updater</th>
                    <th scope="col">Codemagic Patch</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <th scope="row">Hosting</th>
                    <td>EAS-hosted</td>
                    <td>Bring-your-own via plugins</td>
                    <td>Self-hosted Compose stack</td>
                  </tr>
                  <tr>
                    <th scope="row">Fingerprinting</th>
                    <td>Yes</td>
                    <td>Yes</td>
                    <td>Yes</td>
                  </tr>
                  <tr>
                    <th scope="row">Binary diffs</th>
                    <td>Yes</td>
                    <td>Yes</td>
                    <td>Yes</td>
                  </tr>
                  <tr>
                    <th scope="row">Update checks</th>
                    <td>Expo&apos;s API</td>
                    <td>Your server</td>
                    <td>Storage or CDN</td>
                  </tr>
                  <tr>
                    <th scope="row">Release UI</th>
                    <td>EAS web UI</td>
                    <td>Local console</td>
                    <td>Team web dashboard</td>
                  </tr>
                  <tr>
                    <th scope="row">License</th>
                    <td>EAS usage pricing</td>
                    <td>MIT</td>
                    <td>Fair Source License</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className={styles.comparisonFootnote}>
              This is a high-level comparison, products are subject to change.
            </p>
          </div>
        </section>

        <section className={styles.maintainerSection} aria-labelledby="home-maintainer">
          <div className={styles.maintainerInner}>
            <h2 id="home-maintainer">Built by Codemagic.io</h2>
            <p className={styles.maintainerText}>
              Codemagic has been building mobile CI/CD for over 10 years. Our
              teams have delivered billions of over-the-air updates to production
              apps. Patch brings that experience to a self-hosted stack you
              control.
            </p>
            <a
              className={styles.maintainerLink}
              href="https://codemagic.io"
              target="_blank"
              rel="noopener noreferrer">
              Visit Codemagic.io →
            </a>
          </div>
        </section>
      </main>
    </Layout>
  );
}
