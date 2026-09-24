// electron-builder config — identity and publish target come from branding/brand.json only.
const { existsSync, readFileSync } = require('node:fs');
const { join } = require('node:path');

const brand = JSON.parse(readFileSync(join(__dirname, '..', 'branding', 'brand.json'), 'utf8'));
const repoUrl = new URL(brand.repository);
const [, owner, repo] = repoUrl.pathname.replace(/\/$/, '').split('/');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: brand.appId,
  productName: brand.productName,
  copyright: `Copyright (C) ${new Date().getFullYear()}`,
  directories: {
    buildResources: 'branding/icons',
    output: 'release',
  },
  files: [
    'electron/dist/**/*',
    'electron/ui-dist/**/*',
    'electron/package.json',
    'branding/brand.json',
    'branding/wordmark.svg',
    'branding/icons/**/*',
    '!**/node_modules/*/{CHANGELOG.md,README.md,README,readme.md,readme}',
  ],
  extraResources: [
    { from: `resources/${brand.commandName}`, to: brand.commandName },
    { from: 'branding', to: 'branding', filter: ['brand.json', 'wordmark.svg', 'icons/**/*'] },
  ],
  /**
   * electron-builder takes the app entry from the ROOT package.json's `main`,
   * not from electron/package.json. This repo's root manifest is the CLI's npm
   * package, which has no `main` at all (it ships a `bin`), so the packaged app
   * fell back to `index.js` and every build died with "index.js was not found
   * in this archive" — after the asar was already assembled, which is why the
   * failure looked like corruption rather than a missing field.
   *
   * extraMetadata writes `main` into the package.json inside the asar only. The
   * npm manifest stays untouched, which matters: `electron/` is not in its
   * `files`, so a real `main` there would point at a path the tarball lacks.
   *
   * `productName` rides along for a second reason: Electron derives userData
   * from app.getName(), which reads THIS manifest — the top-level productName
   * above only reaches Info.plist. Without it every build stored its data in
   * ~/Library/Application Support/batonhq regardless of brand, so a rebranded
   * app leaked the origin name and shared one singleton lock with Baton, which
   * meant the two could never run at the same time.
   */
  extraMetadata: { main: 'electron/dist/main.js', productName: brand.productName },
  asar: true,
  beforePack: async () => {
    const staged = join(__dirname, '..', 'resources', brand.commandName, 'package', 'dist', 'cli.js');
    if (!existsSync(staged)) {
      throw new Error(
        `Missing staged payload at resources/${brand.commandName}/package — run node config/scripts/stage-payload.mjs`,
      );
    }
  },
  /**
   * The app runs the CLI on ELECTRON's bundled Node — electron/spawn.ts spawns
   * process.execPath with ELECTRON_RUN_AS_NODE=1 — so that Node has to clear the
   * CLI's own floor (package.json `engines`, mirrored by MIN_NODE_MAJOR).
   *
   * Electron 37 bundled Node 22 against a floor of 24, and the result was a
   * packaged app whose Start button could never work: "Baton needs Node >= 24 —
   * this is Node 22.17.1", every time, on both brands. Nothing in the version
   * string says which Node is inside, so ask the binary we actually shipped.
   *
   * Skipped when the packed platform is not the host's, because a Windows exe
   * cannot be executed from a mac build box. CI packs each platform on its own
   * runner, so every artifact that ships is still checked. A cross-ARCH build on
   * the same platform does run — Rosetta covers the x64-on-arm64 case.
   */
  afterPack: async (context) => {
    if (context.electronPlatformName !== process.platform) {
      console.log(`  • skipped bundled-Node check  reason=${context.electronPlatformName} is not the host platform`);
      return;
    }
    const { execFileSync } = require('node:child_process');
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
    const floor = Number(/(\d+)/.exec(pkg.engines.node)[1]);
    const exe = context.electronPlatformName === 'darwin'
      ? join(context.appOutDir, `${brand.productName}.app`, 'Contents', 'MacOS', brand.productName)
      : join(context.appOutDir, `${brand.productName}${context.electronPlatformName === 'win32' ? '.exe' : ''}`);
    const got = execFileSync(exe, ['-e', 'process.stdout.write(process.versions.node)'], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
    }).trim();
    if (Number(got.split('.')[0]) < floor) {
      throw new Error(
        `Electron bundles Node ${got}, but the CLI needs >= ${floor} (node:sqlite FTS5). `
        + 'Every "serve" in the packaged app would fail. Raise the electron devDependency.',
      );
    }
    console.log(`  • bundled Node ${got} clears the CLI floor of ${floor}`);
  },
  publish: {
    provider: 'github',
    owner,
    repo,
  },
  mac: {
    category: 'public.app-category.developer-tools',
    target: [
      { target: 'dmg', arch: ['arm64', 'x64'] },
    ],
    icon: existsSync(join('branding', 'icons', 'icon.icns'))
      ? 'branding/icons/icon.icns'
      : 'branding/icons/icon.png',
    identity: null, // unsigned nightlies until certs land
    artifactName: `${brand.commandName}-macos-\${arch}.\${ext}`,
  },
  dmg: {
    contents: [
      { x: 130, y: 220 },
      { x: 410, y: 220, type: 'link', path: '/Applications' },
    ],
  },
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon: 'branding/icons/icon.ico',
    artifactName: `${brand.commandName}-windows-setup.\${ext}`,
    // unsigned until Authenticode cert is available
    signAndEditExecutable: false,
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    // User-scope PATH for the CLI dir — no admin required.
    runAfterFinish: true,
  },
  linux: {
    target: ['AppImage', 'deb'],
    category: 'Development',
    icon: 'branding/icons',
    artifactName: `${brand.commandName}-linux-\${arch}.\${ext}`,
  },
};
