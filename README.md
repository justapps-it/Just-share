# JustShare

**Phone to phone. Through no one.** Share files and text with devices around you: they travel directly between devices, end-to-end encrypted, and no file is ever stored on a server. No internet? Use the camera. Open source, by [JustApps](https://www.justapps.it) · **[share.justapps.it](https://share.justapps.it)**

🇮🇹 *Invia file e testi ai dispositivi vicini, direttamente e cifrati end-to-end. Senza internet funziona con la fotocamera.*

## Modes

| Mode | How | Network |
| --- | --- | --- |
| Same Wi-Fi | Devices behind the same public IP see each other; WebRTC data channel, normally a direct LAN route | signaling only |
| Code / QR | Pair with a 6-digit code or QR from any network; WebRTC peer-to-peer, encrypted TURN relay only if a network blocks direct connections | internet |
| Offline camera | Animated QR codes carrying a Luby Transform fountain code: the receiver can start at any frame and miss frames; ZXing (WebAssembly) decodes | none |
| Android app | Nearby Connections (Bluetooth / Wi-Fi Direct), like Quick Share | none |

## Security

- Fresh X25519 keys per connection (libsodium `crypto_kx`, WebAssembly); every frame sealed with XChaCha20-Poly1305 — on top of WebRTC's DTLS.
- A 6-digit verification code derived from both public keys is shown on both screens: if they match, nobody is in the middle.
- Every file carries a BLAKE2b-256 checksum, verified on arrival.
- The edge Worker (`worker/index.ts`, Durable Objects) only relays connection setup messages between devices in the same room; it never sees file data and stores nothing.

## Android app

`android/` is a native Kotlin app using **Nearby Connections** (Bluetooth, BLE, Wi-Fi Direct / hotspot): Android phones find each other and transfer files with no internet, like Quick Share. Both phones show the same code before accepting; connections are encrypted. Received files go to *Downloads/JustShare*. It appears in every app's *Share* menu. For iPhone, computers or the camera mode it links to the web app.

The signed APK is a GitHub release asset ([latest](https://github.com/justapps-it/Just-share/releases/latest/download/JustShare.apk)); the site shows the download card automatically. Release a new version with one command:

```bash
npm run release:android     # patch (or minor, major, x.y.z): tests, build, sign, push, GitHub release
```

It needs the Android SDK and the JustApps release key (`JUSTSHARE_KEYSTORE` / `JUSTSHARE_KEYSTORE_PASSWORD`, or the `JUSTCLIP_*` ones, in `~/.gradle/gradle.properties`).

## Relay (optional)

Some mobile networks block direct peer-to-peer connections. To enable the encrypted relay fallback, create a TURN key in the Cloudflare dashboard (*Realtime → TURN*) and store it as Worker secrets:

```bash
npx wrangler secret put TURN_KEY_ID
npx wrangler secret put TURN_KEY_TOKEN
```

Without them JustShare uses STUN only (direct connections).

## Development

```bash
npm install
npm run dev        # /api is proxied to share.justapps.it
npm test           # fountain code, crypto, packets
npm run deploy
E2E_URL=https://share.justapps.it/ node scripts/e2e.mjs   # browsers: pairing, 5 MB transfer, text, offline QR via fake camera
```

## License

[GPL-3.0-or-later](LICENSE).
