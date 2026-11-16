// Turns the package's version into the two versions a Chrome manifest has.
//
// Chrome's "version" must be one to four whole numbers separated by dots, so
// a release label such as 0.3.0-beta.1 cannot go there. "version" gets the
// numeric part, 0.3.0, and "version_name", which Chrome shows to the user and
// does not otherwise read, gets the whole label.

/** Semver, as on semver.org: the three numbers, then an optional pre-release and build label. */
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
/** Chrome refuses a larger number in any place. */
const MAX_PART = 65_535;

/** { version, versionName } for a package version, or an error that says what is wrong with it. */
export function manifestVersions(packageVersion) {
  const match = SEMVER.exec(String(packageVersion));
  if (match === null) {
    throw new Error(`"${packageVersion}" is not a version such as 0.3.0 or 0.3.0-beta.1, so the extension cannot be built with it.`);
  }
  const parts = match.slice(1, 4).map(Number);
  const tooLarge = parts.find((part) => part > MAX_PART);
  if (tooLarge !== undefined) {
    throw new Error(`Chrome allows no number above ${MAX_PART} in a version, and "${packageVersion}" has ${tooLarge}.`);
  }
  return { version: parts.join("."), versionName: String(packageVersion) };
}

/** The manifest as it is built: the one in static/, with the package's version in place of its placeholder. */
export function builtManifest(staticManifest, packageVersion) {
  const { version, versionName } = manifestVersions(packageVersion);
  return { ...staticManifest, version, version_name: versionName };
}
