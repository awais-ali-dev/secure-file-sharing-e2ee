document.getElementById('uploadForm').addEventListener('submit', async (e) => {
  e.preventDefault();

  const fileInput = document.getElementById('fileInput');
  const statusEl = document.getElementById('status');
  const progressTrack = document.getElementById('progressTrack');
  const progressFill = document.getElementById('progressFill');
  const submitBtn = document.getElementById('submitBtn');
  const resultEl = document.getElementById('result');

  const file = fileInput.files[0];
  if (!file) {
    statusEl.textContent = 'Choose a file first.';
    statusEl.className = 'status error';
    return;
  }

  submitBtn.disabled = true;
  resultEl.innerHTML = '';
  progressTrack.style.display = 'block';
  statusEl.className = 'status';

  try {
    // 1. Generate a random per-file key + IV. This key NEVER leaves the browser
    //    except inside the URL fragment of the final share link.
    statusEl.textContent = 'Encrypting in your browser…';
    const key = await generateFileKey();
    const iv = generateIv();

    const fileBuffer = await file.arrayBuffer();
    const encryptedBuffer = await encryptBuffer(key, iv, fileBuffer);

    // The blob we actually upload is [12-byte IV][ciphertext] concatenated
    // together — self-contained, so the recipient's browser can decrypt it
    // without the server ever having to store or hand back the content IV
    // separately. (The IV isn't secret; only the key is.)
    const uploadBlob = new Uint8Array(12 + encryptedBuffer.byteLength);
    uploadBlob.set(iv, 0);
    uploadBlob.set(new Uint8Array(encryptedBuffer), 12);

    // Filename is encrypted too, with a separate IV, so the server never
    // learns what was shared even from its own database.
    const filenameIv = generateIv();
    const encryptedFilename = await encryptString(key, filenameIv, file.name);

    // 2. Ask the server for a presigned S3 PUT URL. The server only learns
    //    the ciphertext's size — never its contents or the key.
    statusEl.textContent = 'Requesting secure upload slot…';
    const urlRes = await fetch('/api/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sizeBytes: uploadBlob.byteLength }),
    });
    if (!urlRes.ok) throw new Error((await urlRes.json()).error || 'Failed to get upload URL.');
    const { fileId, s3Key, uploadUrl } = await urlRes.json();

    // 3. Upload the ciphertext directly to S3 — it never passes through our server.
    statusEl.textContent = 'Uploading encrypted file…';
    await uploadWithProgress(uploadUrl, uploadBlob, (pct) => {
      progressFill.style.width = `${pct}%`;
    });

    // 4. Register metadata (no key, no plaintext filename).
    const expiryHours = Number(document.getElementById('expiryHours').value) || 72;
    const maxDownloads = Number(document.getElementById('maxDownloads').value) || 5;

    const metaRes = await fetch('/api/files', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fileId,
        s3Key,
        encryptedFilename,
        filenameIv: ivToBase64(filenameIv),
        sizeBytes: uploadBlob.byteLength,
        expiryHours,
        maxDownloads,
      }),
    });
    if (!metaRes.ok) throw new Error((await metaRes.json()).error || 'Failed to save file metadata.');

    // 5. Build the share link. The key lives ONLY in the URL fragment —
    //    browsers never send fragments to the server, so this link is the
    //    only place the decryption key exists outside the sender's session.
    const keyBase64 = await exportKeyToBase64Url(key);
    const shareUrl = `${window.location.origin}/f/${fileId}#${keyBase64}`;

    statusEl.textContent = 'Done. Share the link below — it will not be shown again.';
    statusEl.className = 'status success';
    resultEl.innerHTML = `<div class="share-link" id="shareLink">${shareUrl}</div>`;
  } catch (err) {
    console.error(err);
    statusEl.textContent = `Error: ${err.message}`;
    statusEl.className = 'status error';
  } finally {
    submitBtn.disabled = false;
    progressTrack.style.display = 'none';
    progressFill.style.width = '0%';
  }
});

function uploadWithProgress(url, buffer, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`)));
    xhr.onerror = () => reject(new Error('Network error during upload.'));
    xhr.send(buffer);
  });
}
