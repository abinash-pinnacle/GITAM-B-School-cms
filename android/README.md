# Android app (TWA)

> **No APK is built yet.** Replace `your-domain.com` in `twa-manifest.json` (and
> `robots.txt` / `sitemap.xml`) with the real site domain, then build as below.

The Android app is a **Trusted Web Activity**: a thin native
shell that opens the site full-screen, with no browser UI.
There is no separate app codebase — the app *is* the site, so a `git push` that
deploys the site also updates what the app shows. Only a change to the shell
itself (name, icon, package, target URL) needs a new APK.

| | |
|---|---|
| Package | `in.gitam.bschool.cms` |
| Version | 1.1.0 (versionCode 2) |
| Min / target SDK | 21 (Android 5.0) / 36 |
| Signing SHA-256 | `E9:F2:42:…:7D:74` (see `.well-known/assetlinks.json`) |

## Installing

Once built, download `https://<your-domain>/apk/GITAM-BSCHOOL-CMS-v1.1.0.apk` on the
phone and open it. Android will ask to allow installs from unknown sources —
expected for an APK that does not come from the Play Store.

## The signing key

**The current APK is signed with a throwaway key** (`android.keystore` in the
repo root, store/key password `android`). It is git-ignored, and it is fine for
sideloading and demos — but not for the Play Store, and anyone can produce an
APK that Android accepts as an update to this one.

Before publishing, make a real key and keep it safe. **Android identifies an app
by its signing key**: lose it and the app can never be updated, only replaced
under a new package name.

```bash
keytool -genkeypair -v -keystore release.keystore -alias gitam \
  -keyalg RSA -keysize 2048 -validity 10000
```

Then point `android/twa-manifest.json` at it (`signingKey.path`, `signingKey.alias`),
rebuild, and put the new certificate's SHA-256 into `.well-known/assetlinks.json` —
the fingerprint there must match whoever signed the APK, or Android shows the URL
bar instead of a clean full-screen app.

```bash
keytool -list -v -keystore release.keystore -alias gitam | grep SHA256:
```

## Rebuilding

Everything (JDK 17, Android SDK, Bubblewrap) lives in the builder image, so the
host needs nothing but Docker.

```bash
docker build -t twa-builder -f android/builder.Dockerfile android
```

Copy `android/twa-manifest.json` and the keystore into an empty working
directory, then:

```bash
docker run --rm -i -v "$PWD:/work" -w /work -e BUBBLEWRAP_KEYSTORE_PASSWORD=android -e BUBBLEWRAP_KEY_PASSWORD=android twa-builder sh -c 'printf "n\n" | bubblewrap build --skipPwaValidation'
```

The signed APK lands at `app-release-signed.apk`; copy it into `apk/` under a
versioned name. `app-release-bundle.aab` is the Play Store upload format.

Bumping the version: raise `appVersionCode` (and `appVersionName`) in
`twa-manifest.json`, run `bubblewrap update`, then build. Every Play Store
upload needs a higher `versionCode` than the last.
