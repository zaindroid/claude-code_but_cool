// Turns a password into the stored salt:hash form, so a new admin credential can be handed to a
// running deployment through ADMIN_PASSWORD_RESET_HASH without the password itself ever leaving
// this machine. Reads stdin so it never appears in a shell history or a process list.
//
//   node backend/tool/hashPassword.mjs < password.txt
//
// Imports the server's own hashPassword rather than reimplementing scrypt, because the two
// drifting apart would be invisible until a reset silently produced an unusable account.
import { hashPassword } from '../src/users.js';

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const password = Buffer.concat(chunks).toString('utf8').trim();

if (password.length < 8) {
  console.error('Password must be at least 8 characters (read ' + password.length + ' from stdin)');
  process.exit(1);
}
console.log(hashPassword(password));
