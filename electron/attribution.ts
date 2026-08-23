// Copyright (C) 2026 Rakshan Shetty
// SPDX-License-Identifier: AGPL-3.0-or-later
/**
 * Authorship attribution — the half of the app's identity a fork may NOT change.
 *
 * `branding/brand.json` is deliberately swappable: a downstream distribution
 * renames the product, repoints the repository, replaces the icons. That is the
 * whole point of the branding indirection, and none of it is objectionable.
 *
 * What it must not do is erase who wrote the software. So attribution does not
 * live in brand.json — it is compiled into the binary here, and asserted by
 * `test/attribution-preserved.test.ts`. A fork that renames the product keeps a
 * green suite; a fork that removes the credit goes red.
 *
 * This is not decoration. AGPL-3.0 §5(a) requires a modified version to carry
 * prominent notices stating that it is modified, and §7(b) permits the author to
 * require that author attributions be preserved in the Appropriate Legal Notices
 * displayed by works containing the material. NOTICE states that requirement;
 * this file and the About panel are how the running app satisfies it.
 */

/** Frozen so a fork cannot mutate it at runtime instead of editing the source. */
export const ATTRIBUTION = Object.freeze({
  /** The upstream work this distribution is built from. */
  upstreamName: 'Baton',
  /** The copyright holder. Not the distributor — the author. */
  copyright: 'Copyright (C) 2026 Rakshan Shetty',
  license: 'AGPL-3.0-or-later',
  /**
   * Where the corresponding source lives. AGPL §13 requires a network-facing
   * modified version to offer its source to users; §6 requires it on
   * distribution. A downstream must ALSO offer its own modified source — this
   * URL covers the upstream work, not their changes.
   */
  upstreamSource: 'https://github.com/Rakshan001/Baton-Multi-Agent-',
} as const);

/**
 * The credit line shown in the About panel, under whatever name the
 * distribution ships as. `productName` comes from brand.json; everything after
 * it does not.
 */
export function attributionLines(productName: string): string[] {
  const sameName = productName === ATTRIBUTION.upstreamName;
  return [
    sameName
      ? `${ATTRIBUTION.upstreamName} — ${ATTRIBUTION.copyright}`
      : `${productName} is built on ${ATTRIBUTION.upstreamName}.`,
    ...(sameName ? [] : [ATTRIBUTION.copyright]),
    `Licensed under the GNU Affero General Public License, ${ATTRIBUTION.license}.`,
    `Source: ${ATTRIBUTION.upstreamSource}`,
  ];
}
