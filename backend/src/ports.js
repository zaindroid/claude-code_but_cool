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
    found.push({ port, inode: col[9], addr: local.slice(0, local.lastIndexOf(':')) });
  }
  return found;
}

// Which process is behind each socket, best-effort. Costs a walk of /proc, so it only runs when
// there is something to attribute, and only over this account's own processes -- a uid check on
// the /proc/<pid> directory itself, which is cheaper and more honest than parsing status files.
//
// Best-effort is the right contract: a pid can exit between the socket table and the fd scan, and
// a port with no name attached is still a port worth offering. Nothing here throws.
function namesByInode(wanted, uid) {
  const names = new Map();
  if (!wanted.size) return names;
  let pids;
  try {
    pids = fs.readdirSync('/proc').filter((e) => /^\d+$/.test(e));
  } catch {
    return names;
  }
  for (const pid of pids) {
    try {
      if (fs.statSync(`/proc/${pid}`).uid !== uid) continue;
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        // Per descriptor, not per process. A file descriptor can close between the readdir and
        // the readlink, and with one try around the whole loop that one throw abandoned every
        // remaining fd of that process -- including, in practice, the listening socket we came
        // for. Which is why this scan found nothing at all the first time it ran live.
        let link;
        try {
          link = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch {
          continue;
        }
        const m = /^socket:\[(\d+)\]$/.exec(link);
        if (!m || !wanted.has(m[1]) || names.has(m[1])) continue;
        // The first line of cmdline, or comm as a fallback: "vite" and "node" are both more use
        // than a bare number when you are deciding which of three ports to open.
        let name = '';
        try {
          name = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean).slice(0, 2).join(' ');
        } catch {
          /* fall through to comm */
        }
        if (!name) {
          try {
            name = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim();
          } catch {
            /* unnamed is fine */
          }
        }
        names.set(m[1], { pid: Number(pid), command: name.slice(0, 80) });
      }
    } catch {
      /* the process went away mid-walk, or its fds are not ours to read */
    }
  }
  return names;
}

// Every port this account is listening on, deduplicated across the v4 and v6 tables -- a server
// bound to both shows up twice down there and is one server up here.
export function listOwnPorts(user) {
  const raw = [...parseTable('/proc/net/tcp', user.uid), ...parseTable('/proc/net/tcp6', user.uid)];
  const names = namesByInode(new Set(raw.map((r) => r.inode)), user.uid);
  const byPort = new Map();
  for (const r of raw) {
    const known = byPort.get(r.port);
    const named = names.get(r.inode);
    if (!known) byPort.set(r.port, { port: r.port, pid: named?.pid ?? null, command: named?.command || '' });
    else if (!known.command && named) Object.assign(known, named);
  }
  return [...byPort.values()].sort((a, b) => a.port - b.port);
}

// The gate on the preview proxy. Asked per request rather than cached, because the answer changes
// the moment a dev server starts or stops and a cached "no" would be indistinguishable from a
// broken preview.
export function isOwnPort(user, port) {
  return listOwnPorts(user).some((p) => p.port === port);
}
