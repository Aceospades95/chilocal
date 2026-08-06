/* export-digest.mjs — dump the weekly-digest mailing list as CSV.
 *
 * Only members who ticked the digest box at signup (or in Settings) are
 * included — that checkbox is the consent record, so this file IS the
 * mailing list. Run it on the box, paste the CSV into whatever sender
 * you end up using:
 *
 *   docker exec chilocal-api node --experimental-sqlite export-digest.mjs > digest.csv
 */
import { DatabaseSync } from "node:sqlite";

const DATA_DIR = process.env.DATA_DIR || ".";
const db = new DatabaseSync(`${DATA_DIR}/chilocal.db`, { readOnly: true });

// the leading apostrophe defuses formula injection: a member named
// "=HYPERLINK(...)" must not execute when this CSV lands in a spreadsheet
const csv = (s) => {
  let v = String(s);
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
};

const rows = db.prepare(
  "SELECT email, name, created FROM users WHERE wants_digest = 1 ORDER BY created").all();

console.log("email,name,joined");
for (const r of rows)
  console.log(`${csv(r.email)},${csv(r.name)},${new Date(Number(r.created)).toISOString().slice(0, 10)}`);

console.error(`${rows.length} subscriber${rows.length === 1 ? "" : "s"}`);
