import React, {type ReactNode} from 'react';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import HomeTerminal from '@site/src/components/HomeTerminal';

import styles from './index.module.css';

const OTA_REASONS = [
  {
    title: 'Push instant fixes',
    description:
      "Control the full release path to get an urgent fix straight to users' devices.",
  },
  {
    title: 'Ship on your schedule',
    description:
      'Update the product as often as you want, without being slowed down by store reviews.',
  },
  {
    title: 'Rollouts and roll backs',
    description:
      "Revert a bad release or only fully roll out a release when you're ready.",
  },
] as const;

const SYNC_COMMAND = `void sync({
  installMode: "ON_NEXT_SUSPEND",
  minimumBackgroundDuration: 60_000,
});`;

const MANIFEST_PATHS = `# Update path
check:     CDN  /…/meta.json
download:  CDN  /…/bundles
metrics:   API  /report   # separate`;

const LOCAL_EVAL_COMMAND = `./scripts/local-eval/up.sh

# → API        :3001
# → dashboard  :3000
# → MinIO + Postgres`;

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
    terminalLabel: 'sync()',
    terminalContent: SYNC_COMMAND,
    terminalLanguage: 'typescript',
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
    terminalLabel: 'delivery',
    terminalContent: MANIFEST_PATHS,
    terminalLanguage: 'yaml',
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
    reverse: false,
    media: 'image' as const,
    imageAlt:
      'Codemagic Patch metrics: active version distribution and adoption over time',
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
    reverse: true,
    media: 'terminal' as const,
    terminalLabel: 'local-eval',
    terminalContent: LOCAL_EVAL_COMMAND,
    terminalLanguage: 'bash',
  },
] as const;

const COMPARISON_ROWS = [
  {
    feature: 'Hosting',
    expo: 'EAS-hosted',
    hotUpdater: 'Bring-your-own via plugins',
    patch: 'Self-hosted Compose stack',
  },
  {
    feature: 'Fingerprinting',
    expo: 'Yes',
    hotUpdater: 'Yes',
    patch: 'Yes',
  },
  {
    feature: 'Binary diffs',
    expo: 'Yes',
    hotUpdater: 'Yes',
    patch: 'Yes',
  },
  {
    feature: 'Update checks',
    expo: "Expo's API",
    hotUpdater: 'Your server',
    patch: 'Storage or CDN',
  },
  {
    feature: 'Release UI',
    expo: 'EAS web UI',
    hotUpdater: 'Local console',
    patch: 'Team web dashboard',
  },
  {
    feature: 'Team RBAC',
    expo: 'Yes',
    hotUpdater: 'No',
    patch: 'Yes',
  },
  {
    feature: 'License',
    expo: 'EAS usage pricing',
    hotUpdater: 'MIT',
    patch: 'Fair Source License',
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
  const dashboardOverviewSrc = useBaseUrl('/img/dashboard-overview.png');

  return (
    <Layout
      title="Codemagic Patch"
      description="Self-hosted over-the-air updates for immediate fixes and fast release cycles">
      <main className={styles.page}>
        <header className={styles.hero}>
          <div className={styles.heroInner}>
            <h1 className={styles.title}>
              Ship <span className={styles.gradientTextAnimated}>instant updates</span> with
              Codemagic Patch
            </h1>
            <p className={styles.lead}>
              Self-hosted over-the-air updates for React Native. Push immediate fixes and speed up release cycles.
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

        <div className={styles.productShot}>
          <div className={styles.productShotInner}>
            <div className={styles.productShotFrame}>
              <img
                className={styles.productShotImage}
                src={dashboardOverviewSrc}
                alt="Codemagic Patch dashboard showing Production release history, rollouts, and deployment metrics"
                width={3024}
                height={1490}
              />
            </div>
          </div>
        </div>

        <section className={styles.whySection} aria-labelledby="home-why-ota">
          <div className={styles.whyInner}>
            <h2 id="home-why-ota">Don't wait days for an approval</h2>
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
          <h2 id="home-why-patch">
            <span className={styles.gradientTextStatic}>Why use Patch</span> for your OTA updates
          </h2>
          <p className={styles.sectionHeadingLead}>
            Invisible installs, reliable deliveries and release dashboard all in a complete Docker Compose.
          </p>
        </div>

        <div className={styles.featureTimeline}>
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
                  <div className={styles.featureMarker} aria-hidden="true" />
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
                      <HomeTerminal
                        label={section.terminalLabel}
                        language={section.terminalLanguage}>
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
        </div>

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
            <div className={styles.comparisonBg}>
              <div className={styles.comparisonCard}>
                <div
                  className={styles.comparisonGrid}
                  role="table"
                  aria-label="Comparison of Expo Updates, Hot Updater, and Codemagic Patch">
                  <div className={styles.comparisonGridHead} role="row">
                    <div
                      className={styles.comparisonGridCorner}
                      role="columnheader"
                      aria-hidden="true"
                    />
                    <div role="columnheader">Expo Updates</div>
                    <div role="columnheader">Hot Updater</div>
                    <div
                      className={styles.comparisonGridPatchHead}
                      role="columnheader">
                      <span className={styles.comparisonPatchBrand}>
                        Codemagic Patch
                      </span>
                    </div>
                  </div>
                  {COMPARISON_ROWS.map((row) => (
                    <div
                      className={styles.comparisonGridRow}
                      role="row"
                      key={row.feature}>
                      <div className={styles.comparisonFeature} role="rowheader">
                        {row.feature}
                      </div>
                      <div className={styles.comparisonCell} role="cell">
                        <span className={styles.comparisonCellLabel}>
                          Expo Updates
                        </span>
                        <span>{row.expo}</span>
                      </div>
                      <div className={styles.comparisonCell} role="cell">
                        <span className={styles.comparisonCellLabel}>
                          Hot Updater
                        </span>
                        <span>{row.hotUpdater}</span>
                      </div>
                      <div className={styles.comparisonCell} role="cell">
                        <span className={styles.comparisonCellLabel}>
                          Codemagic Patch
                        </span>
                        <span>{row.patch}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
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
