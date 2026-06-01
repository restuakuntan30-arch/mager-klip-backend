const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mager-klip-backend',
    message: 'Backend is running!',
    endpoints: ['/health', '/download?url=YOUTUBE_URL&start=00:00&end=01:00'],
  });
});

app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));

// Coba beberapa player client untuk bypass bot detection
const PLAYER_CLIENTS = [
  'youtube:player_client=android',
  'youtube:player_client=ios',
  'youtube:player_client=web,android',
  'youtube:player_client=tv_embedded',
];

function tryDownload(args, attempt = 0) {
  return new Promise((resolve, reject) => {
    const ytdlp = spawn('yt-dlp', args);
    let stderr = '';
    ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });
    ytdlp.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr));
    });
  });
}

app.get('/download', async (req, res) => {
  const { url, start, end, quality } = req.query;
  if (!url) return res.status(400).json({ error: 'Parameter url diperlukan' });

  const ytIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (!ytIdMatch) return res.status(400).json({ error: 'URL YouTube tidak valid' });
  const ytId = ytIdMatch[1];

  const startTs = start || '00:00';
  const endTs = end || null;
  const q = quality || '720';
  const tempFile = path.join(os.tmpdir(), `clip_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const sectionArg = endTs ? `*${startTs}-${endTs}` : `*${startTs}-99:99:99`;

  // Coba setiap player client sampai berhasil
  let success = false;
  let lastError = '';

  for (let i = 0; i < PLAYER_CLIENTS.length; i++) {
    const playerClient = PLAYER_CLIENTS[i];
    console.log(`[ATTEMPT ${i + 1}] ${ytId} dengan ${playerClient}`);

    const args = [
      url,
      '--download-sections', sectionArg,
      '-f', `best[height<=${q}][ext=mp4]/best[height<=${q}]/best`,
      '--no-playlist',
      '--force-keyframes-at-cuts',
      '-o', tempFile,
      '--no-warnings',
      '--no-progress',
      '--socket-timeout', '30',
      '--extractor-args', playerClient,
      '--user-agent', 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36',
      '--add-header', 'Accept-Language:en-US,en;q=0.9',
    ];

    try {
      await tryDownload(args);
      success = true;
      console.log(`[SUCCESS] ${ytId} via ${playerClient}`);
      break;
    } catch (e) {
      lastError = e.message;
      console.log(`[FAILED] ${playerClient}: ${e.message.slice(0, 100)}`);
      // Lanjut coba player client berikutnya
    }
  }

  if (success && fs.existsSync(tempFile)) {
    const stat = fs.statSync(tempFile);
    console.log(`[DONE] ${ytId} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="magerklip_${ytId}_${startTs.replace(/:/g, '-')}.mp4"`);
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(tempFile);
    stream.pipe(res);
    stream.on('close', () => {
      try { fs.unlinkSync(tempFile); } catch (e) {}
    });
  } else {
    console.error('[FAILED ALL]', lastError.slice(0, 300));
    if (!res.headersSent) {
      res.status(500).json({
        error: 'YouTube memblok server. Coba video lain atau gunakan opsi alternatif.',
        details: lastError.slice(0, 500),
      });
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MagerKlip Backend running on port ${PORT}`));
