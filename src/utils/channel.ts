/** How this build was distributed to the user — decides who owns upgrades. */
export type InstallChannel = 'binary' | 'managed';

/**
 * Compile-time channel marker, substituted by esbuild-style `bun build --define` in
 * `scripts/build-binaries.sh` (`--define "__BUMPER_CHANNEL__='binary'"`). It is a *constant folded
 * into the bundle at build time*, not a runtime env var — the compiled binary carries the value
 * even though its runtime environment never sets it. Undefined in the npm bundle and in dev/test,
 * where the `typeof` guard keeps the reference safe.
 */
declare const __BUMPER_CHANNEL__: string | undefined;

/**
 * Map a raw channel marker to a channel. Anything other than the literal `binary` is `managed` —
 * the safe default that never self-replaces. Pure; {@link installChannel} supplies the baked value.
 */
export function channelFrom(marker: string | undefined): InstallChannel {
  return marker === 'binary' ? 'binary' : 'managed';
}

/**
 * The distribution channel this build shipped through: `binary` for the standalone executable
 * (which self-upgrades), `managed` for a package-manager install (upgraded by that manager).
 */
export function installChannel(): InstallChannel {
  return channelFrom(typeof __BUMPER_CHANNEL__ === 'undefined' ? undefined : __BUMPER_CHANNEL__);
}
