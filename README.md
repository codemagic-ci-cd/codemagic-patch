# Codemagic Patch

[![Discord](https://img.shields.io/discord/1131597315707261018?logo=discord&label=Discord)](https://codemagic.io/discord/) &nbsp; [![react-native-patch on npm](https://img.shields.io/npm/v/@codemagic/react-native-patch?label=react-native-patch)](https://www.npmjs.com/package/@codemagic/react-native-patch) &nbsp; [![capacitor-patch on npm](https://img.shields.io/npm/v/@codemagic/capacitor-patch?label=capacitor-patch)](https://www.npmjs.com/package/@codemagic/capacitor-patch) &nbsp; [![npm downloads](https://img.shields.io/npm/dm/@codemagic/react-native-patch)](https://www.npmjs.com/package/@codemagic/react-native-patch) &nbsp; [![GitHub Stars](https://img.shields.io/github/stars/codemagic-ci-cd/codemagic-patch)](https://github.com/codemagic-ci-cd/codemagic-patch) &nbsp; [![Follow @codemagicio](https://img.shields.io/twitter/follow/codemagicio?style=social)](https://x.com/codemagicio) &nbsp; [![LinkedIn](https://img.shields.io/badge/Follow%20on%20LinkedIn-0A66C2?logo=linkedin&logoColor=white)](https://www.linkedin.com/company/16170400)

Codemagic Patch is a **self-hosted over-the-air (OTA) update service for React Native and Capacitor apps**. Ship JavaScript and web-asset changes straight to installed apps, with no app-store review for changes that live outside the native binary.

---


## Evaluation quickstart

You have two options to try out Patch.

**Local + simulator** - Installs the stack locally and lets you deliver updates to the simulator, including to the included demo app.

**Local + ngrok + device** - Installs the stack locally, plus uses a free ngrok account so you can deliver updates to the app on your real device.

### Local stack + simulator

Run the server on localhost, with a one-click local login. No OAuth account, ngrok account, or domain. You need Docker. This reaches the iOS Simulator, an Android emulator, and a USB-connected Android device. A phone on the network cannot reach it.

```bash
npm install -g @codemagic/patch-cli
cmpatch selfhost local-eval
```

When it finishes, the dashboard is at <http://localhost:8080>. Then run the guided demo. It builds a React Native storefront on a simulator or emulator, publishes a one-line fix, and lets you watch the running app install it:

```bash
cmpatch demo
```

The demo needs Node.js `22.20+`, Yarn (via Corepack), and either Xcode with an iOS Simulator or an Android SDK with a running emulator. See the [on-device demo](examples/on-device-demo/README.md). To connect your own app instead, see [Quickstart: try it locally](docs/local-evaluation.md).

### Local stack + ngrok + device

Run the real server, with sign-in, on your own machine, and reach it from any phone at the free `https://` address your [ngrok](https://ngrok.com) account comes with. You need Docker, a free ngrok account, and a GitHub, Bitbucket, or GitLab account to sign in with. No domain, DNS records, certificates, or open ports.

```bash
npm install -g @codemagic/patch-cli
cmpatch selfhost install --ngrok
```

The command finds your ngrok address, walks you through the OAuth app with that address filled in, installs the server, and points `cmpatch` at it. When it finishes, it prints the dashboard and the two values your app is configured with, both on the ngrok address:

| App config key                  | Value                               |
| ------------------------------- | ----------------------------------- |
| `CodemagicPatchApiUrl`          | `https://<address>`                 |
| `CodemagicPatchDownloadBaseUrl` | `https://<address>/codemagic-patch` |

#### Connect your app

- **React Native:** run `cmpatch login`, then `cmpatch init` from your project root, as the installer prints them. `init` creates one app per platform and writes the URLs and deployment keys into your native projects. Build a release build, then publish with `cmpatch release-react`. Guides: [Native setup](https://patch.codemagic.io/docs/setup/native-setup) · [First release](https://patch.codemagic.io/docs/setup/first-release?sdk=react-native).
- **Capacitor:** install the SDK (`@codemagic/capacitor-patch`) in your app and the CLI (`@codemagic/capacitor-patch-cli`) globally. Sign in with `cmpatch-capacitor login --server-url https://<address>`, create one app per platform with `cmpatch-capacitor app create`, and copy each app's deployment key from `cmpatch-capacitor deployment list`. Put the two URLs and the keys in `capacitor.config.ts` (one block per platform), run `npx cap sync`, and build. Publish with `cmpatch-capacitor release create`. Guides: [Native setup](https://patch.codemagic.io/docs/setup/native-setup-capacitor) · [First release](https://patch.codemagic.io/docs/setup/first-release?sdk=capacitor).

This is for testing: ngrok's free plan carries 1 GB and 20,000 requests a month, and apps keep the address they were built with, so install on your own domain before you ship. See [Install › ngrok](https://patch.codemagic.io/docs/install#ngrok).

---

## Going to production

Install the server from your own machine. You need a host you can reach over SSH, two hostnames (one for the API and dashboard, one for artifact storage), and a GitHub, Bitbucket Cloud, or GitLab account for sign-in. The wizard asks for everything else, and offers to put Cloudflare or CloudFront in front of storage. Without a server or domain of your own, `cmpatch selfhost install --fly` deploys Patch onto Fly.io instead (see [Install › Fly.io](https://patch.codemagic.io/docs/install#fly)).

```bash
npm install -g @codemagic/patch-cli
cmpatch selfhost install
```

Then connect your app and publish a release:

|                   | React Native                                                                                                                                               | Capacitor                                                                                                                                                       |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Connect the app   | `cmpatch init`                                                                                                                                             | `cmpatch-capacitor app create`, then `capacitor.config.ts`                                                                                                      |
| Publish a release | `cmpatch release-react`                                                                                                                                    | `cmpatch-capacitor release create`                                                                                                                              |
| Guides            | [Native setup](https://patch.codemagic.io/docs/setup/native-setup) · [First release](https://patch.codemagic.io/docs/setup/first-release?sdk=react-native) | [Native setup](https://patch.codemagic.io/docs/setup/native-setup-capacitor) · [First release](https://patch.codemagic.io/docs/setup/first-release?sdk=capacitor) |

Start with the [Install guide](https://patch.codemagic.io/docs/install) for the server. Backups, restores, and upgrades also run from your machine, with `cmpatch selfhost backup`, `restore`, and `upgrade` (see [Operations](https://patch.codemagic.io/docs/reference/operations)).

---

## Documentation

The full documentation is at **[patch.codemagic.io/docs](https://patch.codemagic.io/docs/)**. Pages that differ between frameworks have a React Native / Capacitor switcher.

| Topic             | Pages |
| ----------------- | ----- |
| Learn             | [How it works](https://patch.codemagic.io/docs/introduction/how-it-works) · [Core concepts](https://patch.codemagic.io/docs/introduction/core-concepts) · [How delivery works](https://patch.codemagic.io/docs/using-patch/delivery) · How Patch compares: [React Native](https://patch.codemagic.io/docs/introduction/comparison) / [Capacitor](https://patch.codemagic.io/docs/introduction/comparison-capacitor) |
| Run the server    | [Install](https://patch.codemagic.io/docs/install) · [Cloudflare](https://patch.codemagic.io/docs/setup/cloudflare) · [CloudFront](https://patch.codemagic.io/docs/setup/cloudfront) · [Infrastructure](https://patch.codemagic.io/docs/setup/infrastructure) · [Ongoing maintenance](https://patch.codemagic.io/docs/setup/ongoing-maintenance) |
| Integrate the SDK | <a id="part-4--connect-your-react-native-app"></a>Native setup: [React Native](https://patch.codemagic.io/docs/setup/native-setup) / [Capacitor](https://patch.codemagic.io/docs/setup/native-setup-capacitor) · [Checking for updates](https://patch.codemagic.io/docs/setup/checking-for-updates) · [Applying updates](https://patch.codemagic.io/docs/setup/applying-updates) · [Manual control](https://patch.codemagic.io/docs/setup/manual-control) |
| Ship releases     | [Dashboard](https://patch.codemagic.io/docs/using-patch/dashboard) · [Releasing updates](https://patch.codemagic.io/docs/using-patch/releasing-updates) · [Fingerprinting](https://patch.codemagic.io/docs/using-patch/fingerprinting) (React Native) · [Binary versions](https://patch.codemagic.io/docs/using-patch/binary-version-capacitor) (Capacitor) · [Verify a test release](https://patch.codemagic.io/docs/using-patch/verify-test-release) · [Preparing for production](https://patch.codemagic.io/docs/using-patch/preparing-for-production) · [Production control](https://patch.codemagic.io/docs/using-patch/production-control) · <a id="code-signing-optional"></a>[Security and code signing](https://patch.codemagic.io/docs/using-patch/security) · [CI integration](https://patch.codemagic.io/docs/using-patch/ci-integration) |
| Operate           | [Operations](https://patch.codemagic.io/docs/reference/operations) · [Analytics](https://patch.codemagic.io/docs/using-patch/analytics) · [Troubleshooting](https://patch.codemagic.io/docs/troubleshooting) · [FAQ](https://patch.codemagic.io/docs/faq) |
| Reference         | [SDK](https://patch.codemagic.io/docs/reference/sdk-reference) · [`cmpatch` CLI](https://patch.codemagic.io/docs/reference/cli-reference) · [`cmpatch-capacitor` CLI](cli-capacitor/README.md) · [Configuration](https://patch.codemagic.io/docs/reference/configuration) · [Delivery protocol](PROTOCOL.md) |
| Migrate           | [From CodePush](https://patch.codemagic.io/docs/migration/migrating-from-codepush) · [From Expo Updates](https://patch.codemagic.io/docs/migration/migrating-from-expo-updates) · [From Appflow Live Updates](https://patch.codemagic.io/docs/migration/migrating-from-appflow) |
| Release notes     | [All components](https://patch.codemagic.io/docs/releases) |

---

## Community and feedback

Your feedback helps us improve Codemagic Patch. Tell us what works well, what has been challenging, and what you would like to see next.

- 💬 Ask questions in the [Codemagic Discord](https://codemagic.io/discord/), where our developers help out and take feature requests.
- 🗣️ Start a discussion in [GitHub Discussions](https://github.com/codemagic-ci-cd/codemagic-patch/discussions).
- 📅 Book a [feedback call](https://calendly.com/zach-codemagic/30min), or email zach@codemagic.io.
