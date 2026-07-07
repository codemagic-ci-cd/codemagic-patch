import React, {type ReactNode} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import useBaseUrl from '@docusaurus/useBaseUrl';
import Layout from '@theme/Layout';
import HomeTerminal from '@site/src/components/HomeTerminal';

import styles from './index.module.css';

const GITHUB_URL = 'https://github.com/codemagic-ci-cd/codemagic-patch';

const RELEASE_COMMAND = `cmpatch release-react \\
  --platform ios \\
  --deployment Production \\
  --release-notes "Fix onboarding crash" \\
  --rollout-percentage 25 \\
  --yes`;

const INSTALL_COMMAND = `git clone https://github.com/codemagic-ci-cd/codemagic-patch
cd codemagic-patch

scripts/selfhost/install.sh \\
  --api-domain updates.example.com \\
  --storage-domain storage.updates.example.com \\
  --email admin@example.com \\
  --github-oauth-client-id Iv1.xxxxx \\
  --github-oauth-client-secret <secret>`;

const SECTIONS = [
  {
    title: 'Ship OTA updates',
    description:
      'Ship JavaScript and bundled asset changes to installed apps, without waiting on app store review when the change lives in your JS bundle.',
    bullets: [
      'Gradual rollouts and mandatory updates',
      'Rollback from the dashboard or CLI',
      'Delta patches for smaller downloads',
    ],
    link: '/docs/introduction/core-concepts',
    linkLabel: 'Core concepts',
    reverse: false,
    media: 'terminal' as const,
    terminalLabel: 'cmpatch',
    terminalContent: RELEASE_COMMAND,
  },
  {
    title: 'Publish and monitor releases',
    description:
      'Everything you need to publish, monitor, and control releases in production.',
    bullets: [
      'Web dashboard for releases, metrics, and team access',
      'Native fingerprinting flags incompatible releases before they ship',
      'cmpatch CLI for CI; SDK with Expo config plugin',
    ],
    link: '/docs/using-patch/releasing-updates',
    linkLabel: 'Releasing updates',
    reverse: true,
    media: 'image' as const,
    imageAlt:
      'Codemagic Patch web dashboard showing deployment metrics and release history',
  },
  {
    title: 'Self-hostable with Compose',
    description:
      'Run Patch on your own infrastructure, with adapters if needed.',
    bullets: [
      'One Docker Compose stack with server, Postgres, object storage, and HTTPS proxy',
      'Storage and CDN adapters when you outgrow the defaults',
      'GitHub OAuth for CLI and dashboard sign-in',
    ],
    link: '/docs/setup/self-host',
    linkLabel: 'Self-host guide',
    reverse: false,
    media: 'terminal' as const,
    terminalLabel: 'install',
    terminalContent: INSTALL_COMMAND,
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
      <h2 id={id}>{title}</h2>
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
                Read the docs
              </Link>
              <a
                className={styles.secondaryButton}
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer">
                Visit the repo
              </a>
            </div>
          </div>
        </header>

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
                    <td>File-level</td>
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
                    <td>Fair Source (FSL)</td>
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
