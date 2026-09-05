/**
 * File metadata store. Deliberately does NOT store:
 *  - the AES decryption key (lives only in the share link's URL fragment,
 *    which browsers never transmit — the server never sees it)
 *  - the original filename in plaintext (it's encrypted client-side with
 *    the same key as the file, so even a full DB leak reveals nothing
 *    about what was shared or its name)
 */

const path = require('node:path');
const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite'); // built into Node 22.5+ — no native
                                                   // compiler toolchain required, unlike
                                                   // better-sqlite3 which needs Visual
                                                   // Studio Build Tools on Windows.

const dataDir = path.join(__dirname, '..', 'data');
fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'files.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    s3_key TEXT NOT NULL,
    encrypted_filename TEXT NOT NULL,   -- base64 ciphertext, decrypted client-side
    filename_iv TEXT NOT NULL,          -- base64 IV used for the filename encryption
    size_bytes INTEGER NOT NULL,
    max_downloads INTEGER NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    expires_at INTEGER NOT NULL,        -- unix ms
    created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
  );
`);

module.exports = db;
