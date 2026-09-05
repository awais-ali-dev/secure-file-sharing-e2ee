# Secure File Sharing System

A file-sharing portal with genuine **end-to-end encryption** — not just
"encrypted before it hits the database." Files are encrypted in the
sender's browser before a single byte leaves their machine, uploaded
directly to S3 via a presigned URL, and decrypted only in the recipient's
browser. The server and S3 only ever see ciphertext.

## Why this design

The task asks for encryption "during both upload and download." The
straightforward reading — encrypt on the server before writing to S3,
decrypt on the server before sending to the recipient — still means your
server has the plaintext file and the key at some point. If the server is
ever compromised, every file it has touched is exposed.

This implementation instead follows the pattern popularized by Mozilla's
Firefox Send: encryption happens **client-side**, and the decryption key
is embedded in the share link's **URL fragment** (the part after `#`).
Browsers never transmit URL fragments to a server — they're purely a
client-side construct — so the key genuinely never reaches our backend,
its logs, or its database. A full server + database compromise would
expose only meaningless ciphertext blobs and encrypted filenames.

```
Sender's browser                    Server                      AWS S3
─────────────────                   ──────                      ──────
1. Generate random AES-256 key  →   (never sent here)
2. Encrypt file + filename
3. Ask for upload slot          →   Generate presigned PUT URL
4. Upload ciphertext ─────────────────────────────────────────→ stores ciphertext
5. Save metadata (no key!)      →   Store in SQLite
6. Build link: /f/<id>#<key>
                                                          (link sent out-of-band,
                                                           e.g. email/Slack)
Recipient's browser
────────────────────
7. Read key from URL fragment       (server never sees this part of the URL)
8. Ask for download slot        →   Check expiry/limit → presigned GET URL
9. Download ciphertext ←──────────────────────────────────────── serves ciphertext
10. Decrypt in-browser with key from step 7
```

## What's encrypted, and how

| Layer | Mechanism |
|---|---|
| File contents | AES-256-GCM, encrypted client-side before upload |
| Filename | AES-256-GCM, separate IV, same per-file key — server never learns the real filename |
| In transit (browser ↔ S3) | HTTPS (presigned URLs are HTTPS-only) |
| At rest in S3 | SSE-S3 (AES-256) enabled on every object as defense-in-depth, on top of the ciphertext already being opaque |
| Decryption key | Never stored anywhere server-side — lives only in the share link's URL fragment |

The uploaded blob format is `[12-byte IV][ciphertext]` — self-contained,
so the recipient's browser can decrypt it without any extra server-side
metadata beyond the key it already has from the link.

## Signed URLs (the "AWS S3 + signed URLs" requirement)

- `POST /api/upload-url` issues a presigned `PutObject` URL scoped to one
  exact object key, valid for `PRESIGNED_URL_EXPIRY_SECONDS` (default 5
  minutes).
- `POST /api/files/:id/download-url` issues a presigned `GetObject` URL
  the same way, but only after checking the file hasn't expired or hit its
  download limit.
- The server itself never proxies file bytes in either direction — it only
  ever hands out short-lived signed URLs.

## Link expiry & self-destruction

Every uploaded file has:
- an **expiry time** (`DEFAULT_FILE_EXPIRY_HOURS`, default 72h)
- a **max download count** (`DEFAULT_MAX_DOWNLOADS`, default 5)

Both are enforced server-side on every metadata/download request. Once a
file expires or hits its download limit, it's deleted from S3 and the
database immediately (not just hidden) — a burned link can't be replayed.

## Setup

> **Requires Node.js 22.5+** — the metadata store uses `node:sqlite`, which
> ships built into Node itself. This deliberately avoids `better-sqlite3`
> or any other native module that needs a C++ compiler toolchain, since
> those routinely fail to install on Windows machines without Visual
> Studio Build Tools present.

1. **Create an S3 bucket** and an IAM user scoped to just that bucket:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Action": ["s3:PutObject", "s3:GetObject", "s3:DeleteObject"],
       "Resource": "arn:aws:s3:::YOUR-BUCKET-NAME/*"
     }]
   }
   ```
   Never use your AWS root account or a broad-permission key for this.

2. **Install dependencies**
   ```
   npm install
   ```

3. **Configure environment** — copy `.env.example` to `.env` and fill in
   your real `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
   and `S3_BUCKET_NAME`.

4. **Run**
   ```
   npm run dev     # with nodemon
   npm start        # production
   ```

5. Visit `http://localhost:4000`, upload a file, and open the generated
   share link in another tab (or incognito window) to test the full
   round-trip.

## Test data

For testing uploads, use any of Internee.pk's sample reports, or grab a
small dataset from [Kaggle](https://www.kaggle.com/) — a CSV under a few
MB is plenty to exercise the full encrypt → upload → share → download →
decrypt flow without waiting on a large transfer.

## Security notes / limitations

- This is a **staging/demo** build. The share link itself (containing the
  decryption key) must still be sent to the recipient over a channel you
  trust — anyone who intercepts the full link, fragment included, can
  decrypt the file. That's inherent to this pattern (and to Firefox Send's
  original design) — the security guarantee is that *the server operator*
  can't decrypt it, not that the link is safe to post publicly.
- No user accounts — anyone with a valid link can download until it
  expires or hits its limit. Add authentication in front of `/` if only
  specific internal users should be able to create share links.
- Rate limiting is IP-based and in-memory; move to a shared store (Redis)
  if you run more than one server instance.
- `MAX_FILE_SIZE_MB` is enforced only via the size the client reports —
  for stricter enforcement, also set a bucket policy limiting object size.

## Bugs found and fixed during testing

Real-world testing against a live AWS account surfaced three issues not
visible from code review alone — documented here since they're informative
about how presigned URLs and strict CSPs interact in practice:

1. **CORS blocked the browser → S3 PUT.** S3 buckets reject cross-origin
   requests by default. Fixed by adding a bucket CORS policy allowing
   `PUT`/`GET` from the app's origin.
2. **403 SignatureDoesNotMatch on upload.** Two separate causes, both
   because the presigned URL was signed expecting request headers the
   browser's plain `XMLHttpRequest` PUT never actually sends:
   - `ServerSideEncryption: 'AES256'` on the `PutObjectCommand` requires
     the client to send a matching `x-amz-server-side-encryption` header.
     Fixed by removing it from the presign call and relying on the
     bucket's own default encryption setting instead (same encryption-at-
     rest guarantee, no header required from the client).
   - Newer AWS SDK v3 versions default `requestChecksumCalculation` to
     `WHEN_SUPPORTED`, which bakes a checksum requirement into presigned
     URLs that a plain browser PUT can't satisfy. Fixed by setting
     `requestChecksumCalculation: 'WHEN_REQUIRED'` on the `S3Client`.
3. **Download always failed with "invalid, expired, or already used up,"
   even for a freshly-uploaded, unexpired file.** The share page passed
   the file ID to client-side JS via an inline `<script>window.FILE_ID =
   ...</script>` tag — but Helmet's Content Security Policy
   (`script-src 'self'`) blocks inline scripts, so that line silently
   never ran. `download.js` then fetched `/api/files/undefined` on every
   attempt. Fixed by passing the ID via a `data-file-id` attribute on
   `<body>` instead, which needs no inline script and is fully CSP-safe.
