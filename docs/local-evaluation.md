# Quickstart: try it locally

Run the whole service on your machine before you set up domains or OAuth. The **local evaluation stack** runs the real server, release worker, PostgreSQL, Silo, and dashboard, with sign-in replaced by a one-click local login. It serves React Native and Capacitor apps alike. The same walkthrough, with a framework switcher and a dashboard tour, is on the docs site: [Local quickstart](https://patch.codemagic.io/docs/).

You need **Docker** (with Compose v2), **Node.js `20.19+` or `22.12+`**, `git`, and `curl`, on macOS, Linux, or WSL 2.

```bash
npm install -g @codemagic/patch-cli
cmpatch selfhost local-eval
```

The command keeps its own copy of this repository, checks Docker first (and offers to install or start it), brings the stack up, and points `cmpatch` at it. The first run builds images and can take a few minutes. When it finishes, you have:

| Service           | Address                                                         |
| ----------------- | --------------------------------------------------------------- |
| Dashboard         | <http://localhost:8080>, with a prefilled one-click local login |
| API URL           | `http://localhost:3000`                                         |
| Download base URL | `http://localhost:9100/codemagic-patch`                         |

`cmpatch selfhost local-eval status` prints the rest: the services, the Silo console, the seeded API token, and a sample publish command.

<details>
<summary>Start the stack from a clone instead</summary>

```bash
git clone https://github.com/codemagic-ci-cd/codemagic-patch.git
cd codemagic-patch
./scripts/local-eval/up.sh
```

The script needs Node.js `22.20+` and Yarn (via Corepack), and installs `cmpatch` globally itself. In the clone, run `cmpatch demo` from its root, and stop the stack with `cmpatch selfhost local-eval down --checkout .` (`docker compose -f docker-compose.dev.yml down -v` also stops it, but deletes the data).

</details>

## Connect your app

Configure the SDK with the API URL and download base URL above. The iOS Simulator reaches `localhost` directly. For an Android emulator or a USB-connected device, forward both ports first with `adb reverse tcp:3000 tcp:3000` and `adb reverse tcp:9100 tcp:9100`. Android also blocks plain HTTP by default, so for local evaluation the app needs `android:usesCleartextTraffic="true"` on its `<application>` element; remove it before a store build.

- **React Native:** run `cmpatch init --server-url http://localhost:3000` from your project root. It creates one app per platform and wires the SDK into your app. OTA updates apply to release builds only, because debug builds load JavaScript from Metro. See [Local quickstart › React Native](https://patch.codemagic.io/docs/?sdk=react-native#5-try-it-with-your-own-app).
- **Capacitor:** install the SDK (`@codemagic/capacitor-patch`) in your app and the CLI (`@codemagic/capacitor-patch-cli`) globally, sign in with `cmpatch-capacitor login --server-url http://localhost:3000`, and create one app per platform with `cmpatch-capacitor app create`. Then put the URLs and deployment keys in `capacitor.config.ts` and run `npx cap sync`. See [Local quickstart › Capacitor](https://patch.codemagic.io/docs/?sdk=capacitor#5-try-it-with-your-own-app).

## Watch an update apply (optional)

- **React Native:** `cmpatch demo` builds a ready-made storefront app, publishes a one-line fix after you confirm, and lets you watch the app install it over the air. It needs Node.js `22.20+`, Yarn (via Corepack), and either Xcode with an iOS Simulator or an Android SDK with a running emulator. See the [on-device demo](../examples/on-device-demo/README.md).
- **Capacitor:** the [Ionic example app](../client-capacitor/example-app/README.md) runs the check, download, install, and rollback cycle against the local stack from a clone of this repository.

## Stop the stack

```bash
cmpatch selfhost local-eval down                 # keeps the data for the next start
cmpatch selfhost local-eval down --delete-data   # removes the data too
```

> ⚠️ **Evaluation only, not a deployment.** Authentication is disabled and every port binds to localhost, so a phone on your network cannot reach it. To test on real devices before you have a domain, use the [ngrok quickstart](../README.md#local-stack--ngrok--device); to deploy on your own domains, see the [Install guide](https://patch.codemagic.io/docs/install).
