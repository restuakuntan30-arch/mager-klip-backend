const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

// Tulis cookies dari env var ke file saat startup
const COOKIES_FILE = '/tmp/youtube_cookies.txt';
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YOUTUBE_COOKIES);
  console.log('[INIT] ✅ Cookies file ready');
} else {
  console.log('[INIT] ⚠️ No YOUTUBE_COOKIES env var found');
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mager-klip-backend',
    cookies: fs.existsSync(COOKIES_FILE) ? 'loaded' : 'missing',
    endpoints: ['/health', '/download?url=YOUTUBE_URL&start=00:00&end=01:00'],
  });
});

app.get('/health', (req, res) => res.json({ status: 'healthy', timestamp: new Date().toISOString() }));

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
    '--extractor-args', 'youtube:player_client=android,web',
  ];

  if (fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
    console.log('[DOWNLOAD]', ytId, 'with cookies');
  } else {
    console.log('[DOWNLOAD]', ytId, 'WITHOUT cookies (may fail)');
  }

  const ytdlp = spawn('yt-dlp', args);
  let stderr = '';
  ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });

  ytdlp.on('close', (code) => {
    if (code === 0 && fs.existsSync(tempFile)) {
      const stat = fs.statSync(tempFile);
      console.log('[SUCCESS]', ytId, `${(stat.size / 1024 / 1024).toFixed(1)}MB`);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="magerklip_${ytId}_${startTs.replace(/:/g, '-')}.mp4"`);
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(tempFile);
      stream.pipe(res);
      stream.on('close', () => { try { fs.unlinkSync(tempFile); } catch (e) {} });
    } else {
      console.error('[ERROR]', stderr.slice(0, 300));
      if (!res.headersSent) {
        res.status(500).json({
          error: 'Download gagal',
          details: stderr.slice(0, 500),
        });
      }
    }
  });

  req.on('close', () => {
    ytdlp.kill();
    try { fs.unlinkSync(tempFile); } catch (e) {}
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 MagerKlip Backend running on port ${PORT}`));
