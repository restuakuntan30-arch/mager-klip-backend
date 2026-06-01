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
  console.log('[INIT] ✅ Cookies ready');
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

// DEBUG: cek isi cookies
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
    allCookieNames: cookieNames.slice(0, 25),
  });
});

// List format yang available
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

// Download dengan multi player client
const PLAYER_CLIENTS = ['web', 'ios', 'android'];

app.get('/download', async (req, res) => {
  const { url, start, end } = req.query;
  if (!url) return res.status(400).json({ error: 'url required' });

  const ytIdMatch = url.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{11})/);
  if (!ytIdMatch) return res.status(400).json({ error: 'Invalid URL' });
  const ytId = ytIdMatch[1];

  const startTs = start || '00:00';
  const endTs = end || null;
  const sectionArg = endTs ? `*${startTs}-${endTs}` : `*${startTs}-99:99:99`;

  for (let i = 0; i < PLAYER_CLIENTS.length; i++) {
    const client = PLAYER_CLIENTS[i];
    const tempFile = path.join(os.tmpdir(), `clip_${Date.now()}_${i}.mp4`);

    const args = [
      url,
      '--download-sections', sectionArg,
      '-f', 'bv*+ba/best',
      '--merge-output-format', 'mp4',
      '--no-playlist',
      '-o', tempFile,
      '--no-warnings',
      '--socket-timeout', '20',
      '--extractor-args', `youtube:player_client=${client}`,
    ];
    if (fs.existsSync(COOKIES_FILE)) args.push('--cookies', COOKIES_FILE);

    console.log(`[ATTEMPT ${i+1}] ${ytId} via ${client}`);

    const success = await new Promise((resolve) => {
      const ytdlp = spawn('yt-dlp', args);
      let stderr = '';
      ytdlp.stderr.on('data', (d) => { stderr += d.toString(); });
      ytdlp.on('close', (code) => {
        if (code === 0 && fs.existsSync(tempFile) && fs.statSync(tempFile).size > 10000) {
          resolve(true);
        } else {
          console.log(`[FAILED] ${client}: ${stderr.slice(0, 150)}`);
          try { fs.unlinkSync(tempFile); } catch (e) {}
          resolve(false);
        }
      });
    });

    if (success) {
      const stat = fs.statSync(tempFile);
      console.log(`[SUCCESS] ${ytId} via ${client} (${(stat.size/1024/1024).toFixed(1)}MB)`);
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="magerklip_${ytId}.mp4"`);
      res.setHeader('Content-Length', stat.size);
      fs.createReadStream(tempFile).pipe(res).on('close', () => {
        try { fs.unlinkSync(tempFile); } catch (e) {}
      });
      return;
    }
  }

  console.error(`[FAILED ALL] ${ytId}`);
  res.status(500).json({
    error: 'YouTube memblok semua player client',
    details: 'Pakai Cobalt sebagai alternatif',
    fallback: `https://cobalt.tools/?url=${encodeURIComponent(url)}`
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Backend on port ${PORT}`));
