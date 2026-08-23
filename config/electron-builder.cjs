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
  asar: true,
  beforePack: async () => {
    const staged = join(__dirname, '..', 'resources', brand.commandName, 'package', 'dist', 'cli.js');
    if (!existsSync(staged)) {
      throw new Error(
        `Missing staged payload at resources/${brand.commandName}/package — run node config/scripts/stage-payload.mjs`,
      );
    }
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
