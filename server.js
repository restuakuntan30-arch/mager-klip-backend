const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const COOKIES_FILE = '/tmp/youtube_cookies.txt';
if (process.env.YOUTUBE_COOKIES) {
  fs.writeFileSync(COOKIES_FILE, process.env.YOUTUBE_COOKIES);
  console.log('[INIT] ✅ Cookies file ready');
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mager-klip-backend',
    cookies: fs.existsSync(COOKIES_FILE) ? 'loaded' : 'missing',
    endpoints: ['/health', '/download?url=YOUTUBE_URL&start=00:00&end=01:00', '/formats?url=YOUTUBE_URL'],
  });
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// ENDPOINT DEBUG: untuk lihat format apa saja yang available
app.get('/formats', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const args = ['-F', '--no-warnings', url];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);

  const ytdlp = spawn('yt-dlp', args);
  let stdout = '';
  let stderr = '';
  ytdlp.stdout.on('data', (d) => { stdout += d.toString(); });
  ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });
  ytdlp.on('close', (code) => {
    res.json({ code, formats: stdout, error: stderr });
  });
});

app.get('/download', async (req, res) => {
  const { url, start, end } = req.query;
  if (!url) return res.status(400).json({ error: 'Parameter url diperlukan' });

  const ytIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (!ytIdMatch) return res.status(400).json({ error: 'URL YouTube tidak valid' });
  const ytId = ytIdMatch[1];

  const startTs = start || '00:00';
  const endTs = end || null;
  const tempFile = path.join(os.tmpdir(), `clip_${Date.now()}_${Math.random().toString(36).slice(2)}.mp4`);
  const sectionArg = endTs ? `*${startTs}-${endTs}` : `*${startTs}-99:99:99`;

  // Simpel: biar yt-dlp pilih format default, tanpa restriction
  const args = [
    url,
    '--download-sections', sectionArg,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', tempFile,
    '--no-warnings',
    '--socket-timeout', '60',
  ];

  if (fs.existsSync(COOKIES_FILE)) {
    args.push('--cookies', COOKIES_FILE);
  }

  console.log('[DOWNLOAD]', ytId, startTs, '->', endTs);
  console.log('[ARGS]', args.join(' '));

  const ytdlp = spawn('yt-dlp', args);
  let stderr = '';
  ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });
  ytdlp.stdout.on('data', (d) => { console.log('[YT-DLP]', d.toString().trim()); });

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
      console.error('[ERROR]', stderr.slice(0, 500));
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
