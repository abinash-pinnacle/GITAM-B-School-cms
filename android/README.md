# Android app (TWA)

`apk/GITAM-BSCHOOL-CMS-v1.0.0.apk` is a **Trusted Web Activity**: a thin native
shell that opens https://cmsgitam.pintekdigital.com full-screen, with no browser UI.
There is no separate app codebase — the app *is* the site, so a `git push` that
deploys the site also updates what the app shows. Only a change to the shell
itself (name, icon, package, target URL) needs a new APK.

| | |
|---|---|
| Package | `in.gitam.bschool.cms` |
| Version | 1.0.0 (versionCode 1) |
| Min / target SDK | 21 (Android 5.0) / 36 |
| Signing SHA-256 | `FE:2F:DD:…:76:2E` (see `.well-known/assetlinks.json`) |

## Installing

Download `https://cmsgitam.pintekdigital.com/apk/GITAM-BSCHOOL-CMS-v1.0.0.apk` on the
phone and open it. Android will ask to allow installs from unknown sources —
expected for an APK that does not come from the Play Store.

## The signing key

The APK is signed with a release key that lives **outside the repository**, in
`D:\GITAM B-SCHOOL CMS\android-signing\` on the build machine:
`android.keystore` (alias `gitam`) and `keystore-password.txt`. Keep a backup of
that folder somewhere safe. **Android identifies an app by its signing key**:
lose it and the app can never be updated, only replaced under a new package
name. Never commit it — `android.keystore` and `*.jks` are git-ignored.

The certificate's SHA-256 is in `.well-known/assetlinks.json`; it must match
whoever signed the APK, or Android shows the URL bar instead of a clean
full-screen app.

## Rebuilding

Everything (JDK 17, Android SDK, Bubblewrap) lives in the builder image, so the
host needs nothing but Docker.

```bash
docker build -t twa-builder -f android/builder.Dockerfile android
```

Copy `android/twa-manifest.json` and the keystore into an empty working
directory. Hostinger's bot protection answers 403 to the build container, so
point `iconUrl`, `maskableIconUrl` and `webManifestUrl` in that copy at a local
server over this repository (`python3 -m http.server 8765` in the container),
run `bubblewrap update --skipVersionUpgrade`, then put the real
`webManifestUrl` back into `app/build.gradle` before building:

```bash
docker run --rm -i -v "$PWD:/work" -w /work -e BUBBLEWRAP_KEYSTORE_PASSWORD="$PW" -e BUBBLEWRAP_KEY_PASSWORD="$PW" twa-builder sh -c 'printf "n\n" | bubblewrap build --skipPwaValidation'
```

The signed APK lands at `app-release-signed.apk`; copy it into `apk/` under a
versioned name. `app-release-bundle.aab` is the Play Store upload format.

Bumping the version: raise `appVersionCode` (and `appVersionName`) in
`twa-manifest.json`, run `bubblewrap update`, then build. Every Play Store
upload needs a higher `versionCode` than the last.
