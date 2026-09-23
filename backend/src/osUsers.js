// Real OS-level isolation between Forge accounts: each Forge user gets an actual Linux system
// user, with their own home directory under the persistent volume, and every shell/file
// operation for them runs as that uid/gid -- enforced by the kernel's own file permissions, not
// by application code remembering to check an owner field. This is why the main process has to
// run as root (see Dockerfile, no USER directive): only root can create system users and spawn a
// process as a different uid.
//
// What this does and does not protect against, stated plainly rather than implied: a user
// genuinely cannot read another user's files even if they try (0700 home directories, real uid
// separation) -- but everyone's shells still share one container's kernel, PID namespace and
// resource limits. Someone who found a container/kernel escape, or who is simply memory- or
// CPU-hungry, is not contained by this the way a separate VM or container per user would contain
// them. That would need real sandboxing (gVisor, Firecracker, a container per user) -- a much
// bigger build, and not what this implements.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const HOMES_ROOT = process.env.HOMES_ROOT || path.join(process.env.DATA_DIR || path.resolve(process.cwd(), 'data'), 'homes');

// "fu_" (Forge user) as a fixed prefix guarantees this never collides with a real system account
// (root, daemon, www-data, ...) no matter what the person picks as their Forge username.
export function linuxUsernameFor(forgeUsername) {
  const safe = forgeUsername.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 28);
  return `fu_${safe || 'user'}`;
}

export function createOsUser(forgeUsername) {
  const linuxUsername = linuxUsernameFor(forgeUsername);
  const homeDir = path.join(HOMES_ROOT, linuxUsername);
  fs.mkdirSync(HOMES_ROOT, { recursive: true });

  // -M: don't let useradd create the home dir itself (HOMES_ROOT may not exist as a normal home
  // parent); create and own it ourselves right after so we control exactly where it lives, under
  // the persistent volume rather than the default /home.
  try {
    execFileSync('useradd', ['-M', '-d', homeDir, '-s', '/usr/sbin/nologin', linuxUsername], { stdio: 'pipe' });
  } catch (err) {
    if (!String(err.stderr || '').includes('already exists')) throw new Error(`Could not create the system user: ${err.stderr || err.message}`);
  }

  const uid = Number(execFileSync('id', ['-u', linuxUsername]).toString().trim());
  const gid = Number(execFileSync('id', ['-g', linuxUsername]).toString().trim());

  fs.mkdirSync(homeDir, { recursive: true });
  fs.chownSync(homeDir, uid, gid);
  fs.chmodSync(homeDir, 0o700);

  const projectsDir = path.join(homeDir, 'projects');
  fs.mkdirSync(projectsDir, { recursive: true });
  fs.chownSync(projectsDir, uid, gid);

  return { linuxUsername, uid, gid, homeDir, projectsDir };
}

// Every directory/file Forge's own (root) process creates on a user's behalf -- a new project, a
// settings file -- has to be handed back to them explicitly; root creating it means root owns it
// by default, which would defeat the whole point.
export function chownToUser(targetPath, uid, gid) {
  fs.chownSync(targetPath, uid, gid);
}
