/**
 * S3 client + presigned URL helpers.
 *
 * Important: the objects stored here are ALREADY ciphertext by the time
 * they reach this module — encryption happens client-side before upload
 * (see public/crypto.js + public/upload.js). This module's job is just to
 * hand out short-lived, narrowly-scoped URLs so the browser can talk to S3
 * directly, without the file ever passing through our server.
 */

const {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
  // Newer AWS SDK v3 versions default to WHEN_SUPPORTED, which bakes a
  // checksum requirement (x-amz-checksum-crc32 / x-amz-sdk-checksum-algorithm)
  // into presigned URLs. A plain browser XHR/fetch PUT has no way to satisfy
  // that requirement, so S3 rejects the upload with a 403 SignatureDoesNotMatch.
  // WHEN_REQUIRED restores the old behavior: only add checksums when the API
  // actually requires one, which PutObject does not.
  requestChecksumCalculation: 'WHEN_REQUIRED',
});

const BUCKET = process.env.S3_BUCKET_NAME;
const EXPIRY = parseInt(process.env.PRESIGNED_URL_EXPIRY_SECONDS || '300', 10);

/**
 * Generates a presigned PUT URL scoped to exactly one object key.
 * Server-side encryption at rest is handled by the bucket's own default
 * encryption setting (SSE-S3), configured once at the bucket level —
 * NOT via a header on the presigned URL. Signing the URL with an
 * x-amz-server-side-encryption header would require the browser's PUT
 * request to send that exact header too, or S3 rejects the whole
 * request with a 403 SignatureDoesNotMatch. Relying on the bucket
 * default avoids that fragility entirely while still getting the same
 * encryption-at-rest guarantee.
 */
async function getUploadUrl(objectKey, contentLength) {
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: objectKey,
    ContentType: 'application/octet-stream', // opaque ciphertext, not the real file type
    ContentLength: contentLength,
  });
  return getSignedUrl(s3, command, { expiresIn: EXPIRY });
}

/**
 * Generates a presigned GET URL scoped to exactly one object key.
 */
async function getDownloadUrl(objectKey) {
  const command = new GetObjectCommand({ Bucket: BUCKET, Key: objectKey });
  return getSignedUrl(s3, command, { expiresIn: EXPIRY });
}

async function deleteObject(objectKey) {
  const command = new DeleteObjectCommand({ Bucket: BUCKET, Key: objectKey });
  await s3.send(command);
}

module.exports = { getUploadUrl, getDownloadUrl, deleteObject };
