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
let cookiesContent = process.env.YOUTUBE_COOKIES || '';

// Auto-detect base64 encoded cookies
if (cookiesContent && !cookiesContent.includes('# Netscape') && !cookiesContent.includes('youtube.com')) {
  try {
    const decoded = Buffer.from(cookiesContent, 'base64').toString('utf-8');
    if (decoded.includes('youtube.com')) {
      cookiesContent = decoded;
      console.log('[INIT] 🔓 Decoded base64 cookies');
    }
  } catch (e) {}
}

if (cookiesContent) {
  fs.writeFileSync(COOKIES_FILE, cookiesContent);
  console.log('[INIT] ✅ Cookies written, size:', cookiesContent.length, 'bytes');
} else {
  console.log('[INIT] ⚠️ No YOUTUBE_COOKIES env var');
}

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'mager-klip-backend',
    cookies: fs.existsSync(COOKIES_FILE) ? 'loaded' : 'missing',
    endpoints: ['/health', '/download', '/formats', '/debug-cookies'],
  });
});

app.get('/health', (req, res) => res.json({ status: 'healthy' }));

// DEBUG: cek isi cookies file
app.get('/debug-cookies', (req, res) => {
  if (!fs.existsSync(COOKIES_FILE)) return res.json({ exists: false });
  const content = fs.readFileSync(COOKIES_FILE, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  const cookieLines = lines.filter(l => !l.startsWith('#'));
  const cookieNames = cookieLines.map(l => l.split('\t')[5]).filter(Boolean);
  const importantCookies = ['SID', 'HSID', 'SSID', 'APISID', 'SAPISID', '__Secure-1PSID', 'LOGIN_INFO'];
  const foundImportant = importantCookies.filter(c => cookieNames.includes(c));

  res.json({
    exists: true,
    fileSize: content.length,
    totalLines: lines.length,
    cookieCount: cookieLines.length,
    hasNetscapeHeader: content.includes('# Netscape'),
    hasYoutubeDomain: content.includes('youtube.com'),
    hasTabSeparator: cookieLines.length > 0 && cookieLines[0].includes('\t'),
    firstLine: lines[0] || '',
    secondLine: lines[1] || '',
    importantCookiesFound: foundImportant,
    importantCookiesMissing: importantCookies.filter(c => !cookieNames.includes(c)),
    allCookieNames: cookieNames.slice(0, 20),
  });
});

app.get('/formats', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });
  const args = ['-F', '--no-warnings', url];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);
  const ytdlp = spawn('yt-dlp', args);
  let stdout = '', stderr = '';
  ytdlp.stdout.on('data', (d) => { stdout += d.toString(); });
  ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });
  ytdlp.on('close', (code) => res.json({ code, formats: stdout, error: stderr }));
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

  const args = [
    url,
    '--download-sections', sectionArg,
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', tempFile,
    '--no-warnings',
    '--socket-timeout', '60',
  ];
  if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);

  console.log('[DOWNLOAD]', ytId, startTs, '->', endTs);
  const ytdlp = spawn('yt-dlp', args);
  let stderr = '';
  ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });

  ytdlp.on('close', (code) => {
    if (code === 0 && fs.existsSync(tempFile)) {
      const stat = fs.statSync(tempFile);
      console.log('[SUCCESS]', ytId, `${(stat.size / 1024 / 1024).toFixed(1)}MB`);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="magerklip_${ytId}.mp4"`);
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(tempFile).pipe(res).on('close', () => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
      });
    } else {
      console.error('[ERROR]', stderr.slice(0, 300));
      if (!res.headersSent) {
        res.status(500).json({ error: 'Download gagal', details: stderr.slice(0, 500) });
      }
    }
  });

  req.on('close', () => { ytdlp.kill(); try { fs.unlinkSync(tempFile); } catch (e) {} });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend running on port ${PORT}`));
