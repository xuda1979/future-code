import type { PermissionMode } from '../../types/permissions.js'

/** CLI fallback only: explicit modes, settings and policy keep their precedence. */
export function defaultPermissionMode(
  env: Readonly<Record<string, string | undefined>> = process.env,
): PermissionMode {
  // Managed Remote Control has its own authority contract. An SSH/web terminal
  // on an ordinary server does not set FUTURE_CODE_REMOTE.
  const managedRemote = /^(1|true|yes|on)$/i.test(env.FUTURE_CODE_REMOTE ?? '')
  const skip = env.FUTURE_CODE_SKIP_PERMISSIONS
  return !managedRemote && (skip === undefined || /^(1|true|yes|on)$/i.test(skip))
    ? 'bypassPermissions'
    : 'default'
}
