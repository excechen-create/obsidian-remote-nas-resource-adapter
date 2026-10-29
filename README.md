# Obsidian Remote NAS Resource Adapter

Windows-first Obsidian plugin preview, version 0.4.1. Maps absolute Windows image references to read-only NAS WebDAV resources and supplies temporary Blob URLs to existing Obsidian and Adjustable Media image nodes.

## Resource fetching and rendering

The adapter handles path mapping, HTTPS authentication, bounded in-memory data, deduplication and URL lifetimes. Obsidian and AM retain layout, resizing, matrices and their existing viewer. Markdown and AM layout comments are preserved. The plugin does not patch AM or browser networking APIs.

Supported: PNG, JPEG and WebP; Reading View and AM interactive layout images. Ordinary Live Preview, Android, other AM builds and general multi-window behavior are not qualified. The manifest currently restricts the plugin to desktop.

## Test without local originals

Use an absolute **fake Windows root that does not exist**, for example C:\NAS-Test\SynologyDrive, mapped to /Data. A reference such as:

~~~markdown
![Remote](file:///C:/NAS-Test/SynologyDrive/Researcher/example.jpg)
~~~

will resolve to /Data/Researcher/example.jpg on the configured HTTPS origin. Matching uses complete directory segments and the longest configured root. The folder name SynologyDrive is not a global substring hook: explicitly configure the full fake root. Confirm the fake directory and files are absent before testing.

Bare relative paths may be rendered as missing attachments by Obsidian and AM without image nodes. The supported fake absolute file URL lets the existing AM renderer and viewer operate normally. No placeholder images or original NAS files are copied into the Vault.

## Install with BRAT

The repository is public. In Obsidian, install and enable BRAT from Community plugins, then use Add beta plugin and enter `excechen-create/obsidian-remote-nas-resource-adapter`. Select `v0.4.1` if a version is requested and enable the installed adapter. The release supplies manifest.json, main.js and styles.css separately, as well as the ZIP.

GitHub authentication is not required for public access, but anonymous API rate limits can affect BRAT, especially on shared VPN/proxy exits. Wait for the reset or download the release ZIP manually instead of granting broad token permissions. NAS credentials are unrelated to GitHub tokens.

Install and enable Adjustable Media separately for AM layouts and its viewer. Keep session credentials as the default, verify HTTPS, then explicitly enable NAS images. Existing NAS-specific certificate profiles are not distributed in this repository. On a certificate failure, resolve the trust configuration; do not disable TLS validation.

## Build and install

~~~powershell
npm.cmd ci
npm.cmd run check
npm.cmd test
npm.cmd run build
~~~

Builds produce dist/manifest.json, main.js and styles.css (plus a debug source map). Install the first three files in a new independent Vault's .obsidian/plugins/remote-nas-resource-adapter directory. Install your own AM copy separately and enable the plugins in Obsidian. This repository does not distribute AM code.

Defaults are non-working example settings. Fill the HTTPS origin, account and mappings. Verify HTTPS first, enter the password in the plugin's session dialog, then explicitly enable NAS images. Reloading the plugin never automatically enables NAS. Stop clears session credentials. The example config contains no password.

## HTTPS and credentials

The Windows transport fixes the origin, rejects all redirects, validates TLS, limits response bytes and actually closes owned sockets on timeout or unload. Only image GET and finite PROPFIND Depth 0/1 are implemented. There is no NAS write/delete/move operation.

System/Node trust is the default. Advanced certificateTrust configuration may explicitly bind one public leaf certificate, SHA-256 fingerprint, TLS SAN identity, physical IPv4 address and port. Native certificate/name/expiry validation remains enabled. Changes revoke preflight and session credentials; certificate replacement or expiry is rejected. This does not install system roots. Initial certificate ownership must be explicitly established by the user; never automatically trust a captured certificate. See src/certificate-trust.ts for the schema. Do not include private keys.

Passwords are session-only by default. Official Obsidian SecretStorage/SecretComponent is optional and stores only a secret name in plugin settings. Its actual platform security and backup/sync boundary require device-specific checks; other same-user programs/plugins are not isolated. Never commit a real data.json or profile.

## Validation and scope

The local development baseline passed 133 automated tests, synthetic HTTPS/native Obsidian checks, and a bounded real-NAS fake-root test with ordinary images, AM single/matrix/viewer, request deduplication and cleanup. These results are bounded evidence, not laptop/Android or long-term acceptance.

This clean cloud snapshot intentionally omits NAS addresses, certificates, credentials, researcher file paths, private reports, original images and local Git history. All fixture images are generated synthetic assets. Local field-test evidence is retained separately.

Three AM bundle tests explicitly skip when the separately installed, audited AM bundle is absent at test-vault/.obsidian/plugins/adjustable-media/main.js. The remaining tests include real loopback HTTPS sockets and generated test-only certificates. Runtime test private keys remain ignored.
