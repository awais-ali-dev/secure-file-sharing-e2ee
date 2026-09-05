const express = require('express');
const rateLimit = require('express-rate-limit');
const { v4: uuidv4 } = require('uuid');

const db = require('../models/db');
const { getUploadUrl, getDownloadUrl, deleteObject } = require('../config/s3');

const router = express.Router();
router.use(express.json({ limit: '10kb' })); // metadata only — never the file itself

const MAX_FILE_SIZE_BYTES = (parseInt(process.env.MAX_FILE_SIZE_MB || '100', 10)) * 1024 * 1024;
const DEFAULT_EXPIRY_HOURS = parseInt(process.env.DEFAULT_FILE_EXPIRY_HOURS || '72', 10);
const DEFAULT_MAX_DOWNLOADS = parseInt(process.env.DEFAULT_MAX_DOWNLOADS || '5', 10);

// Uploads and downloads go through S3 directly, but the URL-issuing
// endpoints themselves are still worth rate-limiting to slow abuse
// (e.g. someone scripting thousands of upload slots).
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
});
router.use(apiLimiter);

/**
 * Step 1 of upload: browser has already encrypted the file client-side and
 * asks us for a presigned S3 PUT URL. We never see file contents here.
 */
router.post('/upload-url', async (req, res) => {
  const { sizeBytes } = req.body;

  if (!Number.isInteger(sizeBytes) || sizeBytes <= 0) {
    return res.status(400).json({ error: 'sizeBytes must be a positive integer.' });
  }
  if (sizeBytes > MAX_FILE_SIZE_BYTES) {
    return res.status(413).json({ error: `File exceeds the ${process.env.MAX_FILE_SIZE_MB || 100}MB limit.` });
  }

  const fileId = uuidv4();
  const s3Key = `uploads/${fileId}`;

  try {
    const uploadUrl = await getUploadUrl(s3Key, sizeBytes);
    return res.status(200).json({ fileId, s3Key, uploadUrl });
  } catch (err) {
    console.error('Failed to generate upload URL:', err.message);
    return res.status(502).json({ error: 'Could not reach storage backend. Check AWS configuration.' });
  }
});

/**
 * Step 2 of upload: after the browser has PUT the encrypted blob directly
 * to S3, it registers the metadata here. Note what's absent from this
 * payload: no decryption key, and the filename arrives pre-encrypted.
 */
router.post('/files', (req, res) => {
  const {
    fileId,
    s3Key,
    encryptedFilename,
    filenameIv,
    sizeBytes,
    expiryHours,
    maxDownloads,
  } = req.body;

  if (!fileId || !s3Key || !encryptedFilename || !filenameIv || !Number.isInteger(sizeBytes)) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const expiresAt = Date.now() + (Number(expiryHours) || DEFAULT_EXPIRY_HOURS) * 60 * 60 * 1000;

  db.prepare(`
    INSERT INTO files (id, s3_key, encrypted_filename, filename_iv, size_bytes, max_downloads, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    fileId,
    s3Key,
    encryptedFilename,
    filenameIv,
    sizeBytes,
    Number(maxDownloads) || DEFAULT_MAX_DOWNLOADS,
    expiresAt
  );

  return res.status(201).json({ fileId });
});

/**
 * Metadata needed to render the download page BEFORE the recipient clicks
 * download — encrypted filename + size, so the page can show what's
 * waiting without decrypting anything server-side.
 */
router.get('/files/:id', (req, res) => {
  const file = getLiveFileOrExpire(req.params.id);
  if (!file) return res.status(404).json({ error: 'This link is invalid, expired, or already used up.' });

  return res.status(200).json({
    encryptedFilename: file.encrypted_filename,
    filenameIv: file.filename_iv,
    sizeBytes: file.size_bytes,
    downloadsRemaining: file.max_downloads - file.download_count,
    expiresAt: file.expires_at,
  });
});

/**
 * Issues a presigned GET URL for the encrypted blob, enforcing expiry and
 * the download-count limit. Deletes the S3 object once the limit is hit,
 * so a "burned" link can't be reused even if someone replays the request.
 */
router.post('/files/:id/download-url', async (req, res) => {
  const file = getLiveFileOrExpire(req.params.id);
  if (!file) return res.status(404).json({ error: 'This link is invalid, expired, or already used up.' });

  try {
    const downloadUrl = await getDownloadUrl(file.s3_key);

    const newCount = file.download_count + 1;
    db.prepare('UPDATE files SET download_count = ? WHERE id = ?').run(newCount, file.id);

    if (newCount >= file.max_downloads) {
      // Last permitted download — burn the object now rather than waiting
      // for a future request to notice the limit was reached.
      await deleteObject(file.s3_key).catch((err) =>
        console.error('Cleanup after final download failed:', err.message)
      );
      db.prepare('DELETE FROM files WHERE id = ?').run(file.id);
    }

    return res.status(200).json({ downloadUrl });
  } catch (err) {
    console.error('Failed to generate download URL:', err.message);
    return res.status(502).json({ error: 'Could not reach storage backend.' });
  }
});

/**
 * Looks up a file row and lazily expires it (deleting from S3 + DB) if
 * its expiry time has passed or its download limit was already reached.
 */
function getLiveFileOrExpire(id) {
  const file = db.prepare('SELECT * FROM files WHERE id = ?').get(id);
  if (!file) return null;

  const expired = Date.now() > file.expires_at;
  const usedUp = file.download_count >= file.max_downloads;

  if (expired || usedUp) {
    deleteObject(file.s3_key).catch((err) =>
      console.error('Cleanup of expired file failed:', err.message)
    );
    db.prepare('DELETE FROM files WHERE id = ?').run(id);
    return null;
  }

  return file;
}

module.exports = router;
