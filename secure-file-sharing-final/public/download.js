(async () => {
  const infoEl = document.getElementById('info');
  const statusEl = document.getElementById('status');
  const downloadBtn = document.getElementById('downloadBtn');

  const keyBase64 = window.location.hash.slice(1); // fragment, never sent to server
  const fileId = document.body.dataset.fileId; // set server-side via data attribute (CSP-safe — no inline script)
  if (!keyBase64) {
    statusEl.textContent = 'This link is missing its decryption key. Make sure you copied the full URL, including everything after the #.';
    statusEl.className = 'status error';
    return;
  }

  let key;
  try {
    key = await importKeyFromBase64Url(keyBase64);
  } catch {
    statusEl.textContent = 'The decryption key in this link looks corrupted.';
    statusEl.className = 'status error';
    return;
  }

  // Fetch metadata (encrypted filename, size, remaining downloads) so we
  // can show something meaningful before the recipient commits to downloading.
  let meta;
  try {
    const res = await fetch(`/api/files/${fileId}`);
    if (!res.ok) throw new Error((await res.json()).error);
    meta = await res.json();
  } catch (err) {
    statusEl.textContent = err.message || 'This link is invalid or has expired.';
    statusEl.className = 'status error';
    return;
  }

  let filename = 'downloaded-file';
  try {
    filename = await decryptString(key, ivFromBase64(meta.filenameIv), meta.encryptedFilename);
  } catch {
    statusEl.textContent = 'Could not decrypt this file with the key in your link — it may not match this file.';
    statusEl.className = 'status error';
    return;
  }

  const sizeKb = (meta.sizeBytes / 1024).toFixed(1);
  infoEl.innerHTML = `
    <div class="badge">${meta.downloadsRemaining} download${meta.downloadsRemaining === 1 ? '' : 's'} remaining</div>
    <p><strong>${escapeHtml(filename)}</strong> · ${sizeKb} KB</p>
  `;
  downloadBtn.disabled = false;

  downloadBtn.addEventListener('click', async () => {
    downloadBtn.disabled = true;
    statusEl.className = 'status';
    try {
      statusEl.textContent = 'Requesting secure download link…';
      const urlRes = await fetch(`/api/files/${fileId}/download-url`, { method: 'POST' });
      if (!urlRes.ok) throw new Error((await urlRes.json()).error);
      const { downloadUrl } = await urlRes.json();

      statusEl.textContent = 'Downloading encrypted file…';
      const blobRes = await fetch(downloadUrl);
      if (!blobRes.ok) throw new Error('Download from storage failed.');
      const encryptedBuffer = await blobRes.arrayBuffer();

      statusEl.textContent = 'Decrypting in your browser…';
      // The blob is [12-byte IV][ciphertext], written that way by upload.js
      // specifically so the recipient doesn't need any extra server-stored
      // metadata to decrypt the content itself.
      const contentIv = new Uint8Array(encryptedBuffer.slice(0, 12));
      const ciphertext = encryptedBuffer.slice(12);
      const decrypted = await decryptBuffer(key, contentIv, ciphertext);

      const blob = new Blob([decrypted]);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();

      statusEl.textContent = 'Downloaded and decrypted successfully.';
      statusEl.className = 'status success';
    } catch (err) {
      statusEl.textContent = `Error: ${err.message}`;
      statusEl.className = 'status error';
      downloadBtn.disabled = false;
    }
  });

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }
})();
