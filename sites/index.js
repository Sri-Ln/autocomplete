/**
 * sites/index.js — the adapter registry list.
 *
 * ADDING A SITE — three edits, total:
 *   1. create sites/<name>.js, following the shape in sites/workday.js
 *   2. add it to the `js` array in manifest.json (before content/registry.js)
 *   3. add it to the array below
 *   ...plus its host pattern in manifest.json → content_scripts.matches
 *
 * Order matters only if two adapters could match the same host. First match wins.
 */

AF.SITES = [
  AF.sites.workday,
  // AF.sites.greenhouse,
  // AF.sites.lever,
];
