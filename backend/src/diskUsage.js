// Real disk usage, not an estimate -- `du` walks the actual filesystem under a home directory,
// same as a person would run by hand to check. Enforced at the one point growth actually happens
// through Forge's own UI (creating a new project); it can't stop someone from, say, git-cloning a
// huge repo into an *existing* project mid-terminal-session -- see app.yaml's own note on why a
// real kernel-enforced quota isn't what this is. This is a real, honest limit on the main growth
// path, not a hard wall.
import { execFileSync } from 'node:child_process';

export const GB = 1024 ** 3;
export const PLATFORM_QUOTA_BYTES = Number(process.env.PLATFORM_QUOTA_GB || 100) * GB;
export const DEFAULT_USER_QUOTA_BYTES = Number(process.env.DEFAULT_USER_QUOTA_GB || 20) * GB;

export function duBytes(path) {
  try {
    // -s: total only, not per-file. -B1: bytes, not du's own human-rounded units.
    const out = execFileSync('du', ['-sB1', path], { stdio: ['ignore', 'pipe', 'ignore'] }).toString();
    return Number(out.split('\t')[0]) || 0;
  } catch {
    return 0; // a home dir that doesn't exist yet (brand new account) is just zero used, not an error
  }
}

export function checkCanCreateProject(user, { dataDir }) {
  const userUsed = duBytes(user.homeDir);
  if (userUsed >= user.quotaBytes) {
    throw Object.assign(
      new Error(`You're at your storage limit (${(userUsed / GB).toFixed(1)}GB of ${(user.quotaBytes / GB).toFixed(0)}GB) -- ask an admin for more space, or free some up first.`),
      { status: 507 }
    );
  }
  const platformUsed = duBytes(dataDir);
  if (platformUsed >= PLATFORM_QUOTA_BYTES) {
    throw Object.assign(
      new Error(`The whole platform is at its storage limit (${(platformUsed / GB).toFixed(0)}GB of ${(PLATFORM_QUOTA_BYTES / GB).toFixed(0)}GB) -- an admin needs to free up space before new projects can be created.`),
      { status: 507 }
    );
  }
}
