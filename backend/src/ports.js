// What this account has listening, read from the kernel rather than guessed.
//
// Preview used to begin by asking which port your dev server was on, with a comment explaining
// that guessing wrong silently is worse than asking once. That is true, and it is also a false
// choice: /proc/net/tcp lists every listening socket together with the uid that owns it, and this
// app already gives every Codez account its own real Linux uid (osUsers.js). So "which ports are
// yours" has an exact answer, and asking for it was only ever a stand-in for reading it.
//
// The uid filter is doing real work here, twice over. It keeps one account from seeing another's
// dev server in the list, and -- through isOwnPort below -- it keeps the preview proxy from being
// able to reach one. Both accounts share a container and therefore share 127.0.0.1, so without it
// "preview port 3000" means "preview whoever got to 3000 first".
import fs from 'node:fs';

// Listening, in /proc/net/tcp's own notation. Every other state is a connection, not a server.
const TCP_LISTEN = '0A';

// Columns are fixed and space-separated: sl, local_address, rem_address, st, tx:rx, tr:when,
// retrnsmt, uid, timeout, inode. Both the v4 and v6 tables use the same shape, differing only in
// how wide the address half is -- which is why the address is split on ':' from the right rather
// than parsed as an address at all. The port is all this needs.
function parseTable(file, uid) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return []; // no v6 table on a v4-only kernel, and /proc is absent off Linux
  }
  const found = [];
  for (const line of text.split('\n').slice(1)) {
    const col = line.trim().split(/\s+/);
    if (col.length < 10 || col[3] !== TCP_LISTEN) continue;
    if (Number(col[7]) !== uid) continue;
    const local = col[1];
    const port = parseInt(local.slice(local.lastIndexOf(':') + 1), 16);
    if (!port) continue;
    found.push({ port });
  }
  return found;
}

// Why there is no process name beside each port.
//
// Mapping a socket to the process holding it means matching /proc/net/tcp's inode against the
// /proc/<pid>/fd symlinks, and reading another uid's fd directory requires PTRACE_MODE_READ --
// which root only has with CAP_SYS_PTRACE. Docker's default capability set does not include it,
// so this server, root though it is, gets EACCES on every account's fds.
//
// Measured rather than assumed: the same matching loop, run inside this container as the account
// itself, reports `pids total 14, owned by uid 8, fd-unreadable 0, matches 1` and names the pid.
// Run from the server it reads zero fds and names nothing. The code for it was here and did
// exactly that -- a full /proc walk every poll, for every signed-in tab, that could never return
// an answer. It is gone rather than left in looking plausible.
//
// If a name is ever worth having, the route is a helper run as the account (`su <user> -c ...`),
// not a capability added to the whole container for a label.

// Every port this account is listening on, deduplicated across the v4 and v6 tables -- a server
// bound to both shows up twice down there and is one server up here.
export function listOwnPorts(user) {
  const raw = [...parseTable('/proc/net/tcp', user.uid), ...parseTable('/proc/net/tcp6', user.uid)];
  const ports = [...new Set(raw.map((r) => r.port))];
  return ports.sort((a, b) => a - b).map((port) => ({ port }));
}

// The gate on the preview proxy. Asked per request rather than cached, because the answer changes
// the moment a dev server starts or stops and a cached "no" would be indistinguishable from a
// broken preview.
export function isOwnPort(user, port) {
  return listOwnPorts(user).some((p) => p.port === port);
}
