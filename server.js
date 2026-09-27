'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
require('dotenv').config();
const { spawn, spawnSync } = require('node:child_process');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { Server } = require('socket.io');
const archiver = require('archiver');
const yauzl = require('yauzl');
const toml = require('smol-toml');
const yaml = require('yaml');

const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const LOG_LIMIT = 500;
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 3000);
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const serverRoot = path.resolve(process.env.MC_SERVER_DIR || path.join(ROOT, 'minecraft-server'));
const backendRoot = path.resolve(process.env.MC_BACKEND_DIR || path.join(path.dirname(serverRoot), `${path.basename(serverRoot)}-lobby`));
const backendJarPath = path.join(backendRoot, 'server.jar');
let jarPath = path.resolve(process.env.MC_SERVER_JAR || path.join(serverRoot, 'server.jar'));
let javaCommand = process.env.JAVA_COMMAND || 'java';
const maxHeapMb = Math.max(512, Math.floor(os.totalmem() / 1024 / 1024 * 0.75));

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(BACKUP_DIR, { recursive: true });
fs.mkdirSync(serverRoot, { recursive: true });
if (!fs.existsSync(USERS_FILE)) fs.writeFileSync(USERS_FILE, '[]\n');
if (!fs.existsSync(SETTINGS_FILE)) fs.writeFileSync(SETTINGS_FILE, JSON.stringify({ minHeapMb: 1024, maxHeapMb: Math.min(4096, maxHeapMb), jarPath: 'server.jar' }, null, 2));
if (!process.env.MC_SERVER_JAR) {
  const savedJarPath = loadJson(SETTINGS_FILE, {}).jarPath;
  if (typeof savedJarPath === 'string') {
    const candidate = path.resolve(serverRoot, savedJarPath);
    const relative = path.relative(serverRoot, candidate);
    if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) && path.extname(candidate).toLowerCase() === '.jar') jarPath = candidate;
  }
}

const app = express();
const httpServer = http.createServer(app);
const io = new Server(httpServer);
const sessionMiddleware = session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.COOKIE_SECURE === 'true', maxAge: 1000 * 60 * 60 * 24 * 7 }
});
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '1mb' }));
app.use(sessionMiddleware);
app.use(express.static(path.join(ROOT, 'public')));
io.engine.use(sessionMiddleware);
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Troppi tentativi. Riprova tra qualche minuto.' } });
const adminSignupLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Troppi tentativi di creazione admin. Riprova più tardi.' } });
const serverCreateLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 3, standardHeaders: 'draft-8', legacyHeaders: false, message: { error: 'Troppi tentativi di creazione server. Riprova più tardi.' } });

let processChild = null;
let backendChild = null;
let serverState = 'offline';
let serverStage = 'offline';
let consoleHistory = [];
let serverStartedAt = null;
let restartPending = false;
let stoppingAll = false;
let backendReady = false;
let stackStopPending = false;
let playerSnapshot = { online: 0, max: 0, names: [] };
let lastCpuSample = null;
let backupInProgress = false;

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function saveJson(file, value) {
  const tempFile = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tempFile, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempFile, file);
}
function safeName(name) {
  return typeof name === 'string' && /^[a-zA-Z0-9_ -]{3,24}$/.test(name.trim());
}
function normalizeServerHostname(input) {
  if (input === undefined || input === null || input === '') return '';
  if (typeof input !== 'string') throw new Error('Dominio non valido');
  const hostname = input.trim().toLowerCase().replace(/\.$/, '');
  if (hostname.length > 253) throw new Error('Il dominio supera 253 caratteri');
  const labels = hostname.split('.');
  if (labels.length < 2 || labels.some(label => label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))) {
    throw new Error('Inserisci un dominio valido, per esempio play.esempio.it, senza protocollo o porta');
  }
  return hostname;
}
function secretMatches(input, expected) {
  if (typeof input !== 'string' || typeof expected !== 'string') return false;
  const inputBuffer = Buffer.from(input);
  const expectedBuffer = Buffer.from(expected);
  return inputBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(inputBuffer, expectedBuffer);
}
function normalizeRelative(input) {
  if (typeof input !== 'string' || input.includes('\0')) throw new Error('Percorso non valido');
  const resolved = path.resolve(serverRoot, input || '.');
  if (resolved !== serverRoot && !resolved.startsWith(`${serverRoot}${path.sep}`)) throw new Error('Percorso fuori dalla directory del server');
  const rootRealPath = fs.realpathSync(serverRoot);
  let existingPath = resolved;
  while (!fs.existsSync(existingPath)) {
    const parent = path.dirname(existingPath);
    if (parent === existingPath) throw new Error('Percorso non valido');
    existingPath = parent;
  }
  const existingRealPath = fs.realpathSync(existingPath);
  if (existingRealPath !== rootRealPath && !existingRealPath.startsWith(`${rootRealPath}${path.sep}`)) throw new Error('Percorso fuori dalla directory del server');
  return resolved;
}
function relativeName(absolute) {
  return path.relative(serverRoot, absolute).split(path.sep).join('/') || '.';
}
function users() { return loadJson(USERS_FILE, []); }
function currentUser(req) {
  return users().find(user => user.id === req.session.userId) || null;
}
function requireAuth(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'Autenticazione richiesta' });
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Permesso admin richiesto' });
  next();
}
function canUseConsole(user) { return user?.role === 'admin' || user?.consoleAccess === true; }
function publicUser(user) { return { id: user.id, username: user.username, role: user.role, consoleAccess: user.role === 'admin' || user.consoleAccess === true }; }
function listBackups() {
  return fs.readdirSync(BACKUP_DIR).filter(name => name.endsWith('.zip')).map(name => {
    const stat = fs.statSync(path.join(BACKUP_DIR, name));
    return { id: name.slice(0, -4), size: stat.size, createdAt: stat.mtime.toISOString() };
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function backupPath(id) {
  if (typeof id !== 'string' || !/^[0-9TZ-]+-[a-f0-9]{8}$/.test(id)) throw new Error('ID backup non valido');
  return path.join(BACKUP_DIR, `${id}.zip`);
}
function captureMetrics() {
  const cpuTimes = os.cpus().reduce((result, cpu) => {
    for (const [state, value] of Object.entries(cpu.times)) result[state] = (result[state] || 0) + value;
    return result;
  }, {});
  let cpuPercent = 0;
  if (lastCpuSample) {
    const elapsed = Object.values(cpuTimes).reduce((sum, value) => sum + value, 0) - Object.values(lastCpuSample).reduce((sum, value) => sum + value, 0);
    const idle = cpuTimes.idle - lastCpuSample.idle;
    if (elapsed > 0) cpuPercent = Math.round((1 - idle / elapsed) * 1000) / 10;
  }
  lastCpuSample = cpuTimes;
  let disk = null;
  try {
    const stats = fs.statfsSync(serverRoot);
    disk = { totalBytes: stats.blocks * stats.bsize, freeBytes: stats.bavail * stats.bsize };
  } catch {}
  return {
    capturedAt: new Date().toISOString(), cpuPercent,
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() }, disk,
    process: { pid: processChild?.pid || null, uptimeSeconds: serverStartedAt ? Math.floor((Date.now() - serverStartedAt) / 1000) : 0 },
    players: playerSnapshot
  };
}
function parsePlayers(line) {
  const match = line.match(/There are (\d+) of a max of (\d+) players online(?::\s*(.*))?/i);
  if (!match) return;
  playerSnapshot = { online: Number(match[1]), max: Number(match[2]), names: (match[3] || '').split(',').map(name => name.trim()).filter(Boolean) };
  io.emit('server:players', playerSnapshot);
}
function getJavaRuntime() {
  const result = spawnSync(javaCommand, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const version = output.match(/version "([^"]+)"/);
  return { command: javaCommand, executable: path.basename(javaCommand), version: version?.[1] || 'Non rilevata', available: result.status === 0 };
}
function getAvailableJavaRuntimes() {
  const candidates = new Set([javaCommand]);
  if (process.env.JAVA_HOME) candidates.add(path.join(process.env.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  if (process.platform === 'win32') {
    const where = spawnSync('where.exe', ['java'], { encoding: 'utf8', timeout: 3000, windowsHide: true });
    for (const line of (where.stdout || '').split(/\r?\n/).filter(Boolean)) candidates.add(line.trim());
    for (const base of [path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Eclipse Adoptium'), path.join(os.homedir(), '.jdks')]) {
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory() && /^(jdk|temurin|openjdk)/i.test(entry.name)) candidates.add(path.join(base, entry.name, 'bin', 'java.exe'));
        }
      } catch {}
    }
  }
  const seen = new Set();
  return [...candidates].map(command => getJavaRuntimeFor(command)).filter(runtime => {
    const key = path.resolve(runtime.command).toLowerCase();
    if (!runtime.available || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function getJavaRuntimeFor(command) {
  const result = spawnSync(command, ['-version'], { encoding: 'utf8', timeout: 5000, windowsHide: true });
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  const version = output.match(/version "([^"]+)"/);
  return { command, executable: path.basename(command), version: version?.[1] || 'Non rilevata', available: result.status === 0 };
}
const PAPERMC_API = 'https://fill.papermc.io/v3';
const PAPERMC_USER_AGENT = 'Lantern-Minecraft-Panel/1.0 (https://docs.papermc.io/)';
let paperVersionsCache = { expiresAt: 0, versions: [] };
async function fetchJson(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`Download provider non disponibile (${response.status})`);
  return response.json();
}
async function getSoftwareVersions(software) {
  if (software === 'vanilla') {
    const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
    return manifest.versions.filter(version => version.type === 'release').map(version => version.id);
  }
  if (software === 'paper') return getStablePaperVersions();
  if (software === 'velocity') {
    const project = await fetchJson(`${PAPERMC_API}/projects/${software}`, { 'User-Agent': PAPERMC_USER_AGENT });
    const versions = Object.values(project.versions || {}).flat();
    if (!versions.length) throw new Error(`Nessuna versione disponibile per ${software}`);
    return [...new Set(versions.filter(version => typeof version === 'string'))];
  }
  throw new Error('Software non supportato');
}
async function getStablePaperVersions() {
  if (paperVersionsCache.expiresAt > Date.now()) return paperVersionsCache.versions;
  const project = await fetchJson(`${PAPERMC_API}/projects/paper`, { 'User-Agent': PAPERMC_USER_AGENT });
  const candidates = [...new Set(Object.values(project.versions || {}).flat())].filter(version => /^\d+(?:\.\d+)+$/.test(version));
  const stableVersions = [];
  for (let index = 0; index < candidates.length && stableVersions.length < 12; index += 6) {
    const checks = await Promise.all(candidates.slice(index, index + 6).map(async version => {
      try {
        const builds = await fetchJson(`${PAPERMC_API}/projects/paper/versions/${encodeURIComponent(version)}/builds`, { 'User-Agent': PAPERMC_USER_AGENT });
        return Array.isArray(builds) && builds.some(build => build.channel === 'STABLE' && build.downloads?.['server:default']?.url) ? version : null;
      } catch { return null; }
    }));
    stableVersions.push(...checks.filter(Boolean));
  }
  if (!stableVersions.length) throw new Error('Nessuna release Paper stabile disponibile');
  paperVersionsCache = { expiresAt: Date.now() + 30 * 60 * 1000, versions: stableVersions };
  return stableVersions;
}
async function getPapermcStableBuild(software, version) {
  const builds = await fetchJson(`${PAPERMC_API}/projects/${software}/versions/${encodeURIComponent(version)}/builds`, { 'User-Agent': PAPERMC_USER_AGENT });
  const build = Array.isArray(builds) ? builds.find(candidate => candidate.channel === 'STABLE' && candidate.downloads?.['server:default']?.url) : null;
  if (!build) throw new Error(`Nessuna build stabile disponibile per ${version}`);
  const download = build.downloads['server:default'];
  return { url: download.url, algorithm: 'sha256', checksum: download.checksums?.sha256, label: `${version} build ${build.id}` };
}
async function getServerArtifact(software, version) {
  if (software === 'paper' || software === 'velocity') return getPapermcStableBuild(software, version);
  if (software !== 'vanilla') throw new Error('Software non supportato');
  const manifest = await fetchJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
  const versionEntry = manifest.versions.find(candidate => candidate.id === version && candidate.type === 'release');
  if (!versionEntry) throw new Error('Versione Vanilla non trovata nel catalogo ufficiale');
  const metadata = await fetchJson(versionEntry.url);
  const download = metadata.downloads?.server;
  if (!download?.url || !download.sha1) throw new Error('Download Vanilla non disponibile per questa versione');
  return { url: download.url, algorithm: 'sha1', checksum: download.sha1, label: version };
}
async function downloadServerArtifact(artifact, destination) {
  if (!artifact.checksum) throw new Error('Il provider non ha fornito un checksum verificabile');
  const downloadUrl = new URL(artifact.url);
  const trustedDomain = downloadUrl.protocol === 'https:' && (downloadUrl.hostname.endsWith('.mojang.com') || downloadUrl.hostname.endsWith('.papermc.io'));
  if (!trustedDomain) throw new Error('Host di download non autorizzato');
  const response = await fetch(downloadUrl, { headers: { 'User-Agent': PAPERMC_USER_AGENT }, signal: AbortSignal.timeout(300000) });
  if (!response.ok || !response.body) throw new Error(`Download JAR fallito (${response.status})`);
  const declaredSize = Number(response.headers.get('content-length') || 0);
  const maxDownloadBytes = 2 * 1024 * 1024 * 1024;
  if (declaredSize > maxDownloadBytes) throw new Error('Il JAR supera il limite di 2 GB');
  const hash = crypto.createHash(artifact.algorithm);
  let size = 0;
  const verifyStream = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > maxDownloadBytes) return callback(new Error('Il JAR supera il limite di 2 GB'));
    hash.update(chunk);
    callback(null, chunk);
  } });
  await pipeline(Readable.fromWeb(response.body), verifyStream, fs.createWriteStream(destination, { flags: 'wx' }));
  if (hash.digest('hex').toLowerCase() !== artifact.checksum.toLowerCase()) throw new Error('Il checksum del JAR non coincide');
  return size;
}
function getServerConfiguration(serverType) {
  const configFile = path.join(serverRoot, serverType === 'velocity' ? 'velocity.toml' : 'server.properties');
  if (!fs.existsSync(configFile)) return { file: path.basename(configFile), exists: false, values: {}, backends: {} };
  const lines = fs.readFileSync(configFile, 'utf8').split(/\r?\n/);
  if (serverType !== 'velocity') {
    const allValues = {};
    for (const line of lines) {
      const separator = line.indexOf('=');
      if (separator < 1 || line.trimStart().startsWith('#')) continue;
      allValues[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
    }
    const safeKeys = ['server-ip', 'server-port', 'motd', 'max-players', 'online-mode', 'difficulty', 'gamemode', 'level-name', 'pvp', 'white-list'];
    return { file: path.basename(configFile), exists: true, values: Object.fromEntries(safeKeys.filter(key => key in allValues).map(key => [key, allValues[key]])), backends: {} };
  }
  let inServers = false;
  let bind = '';
  const backends = {};
  for (const line of lines) {
    if (/^\s*\[/.test(line)) { inServers = /^\s*\[servers\]\s*(?:#.*)?$/.test(line); continue; }
    const bindMatch = line.match(/^\s*bind\s*=\s*"([^"]+)"/);
    if (bindMatch) bind = bindMatch[1];
    if (inServers) {
      const serverMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*"([^"]+)"/);
      if (serverMatch && serverMatch[1] !== 'try') backends[serverMatch[1]] = serverMatch[2];
    }
  }
  return { file: path.basename(configFile), exists: true, values: bind ? { bind } : {}, backends };
}
function logLine(line, type = 'output') {
  const entry = { line: String(line).replace(/\r$/, ''), type, at: new Date().toISOString() };
  consoleHistory.push(entry);
  if (consoleHistory.length > LOG_LIMIT) consoleHistory = consoleHistory.slice(-LOG_LIMIT);
  io.to('console').emit('console:line', entry);
}
function setState(state) {
  serverState = state;
  io.emit('server:state', state);
}
function getSettings() {
  const settings = { minHeapMb: 1024, maxHeapMb: 2048, jarPath: 'server.jar', serverName: '', serverVersion: '', serverHostname: '', serverType: process.env.MC_SERVER_TYPE === 'velocity' ? 'velocity' : 'paper', javaCommand: process.env.JAVA_COMMAND || 'java', backupIntervalHours: 0, lastBackupAt: 0, ...loadJson(SETTINGS_FILE, {}) };
  if (settings.serverType === 'minecraft') settings.serverType = 'paper';
  if (!['paper', 'vanilla', 'velocity'].includes(settings.serverType)) settings.serverType = 'paper';
  settings.backend = { enabled: false, name: 'lobby', port: 30066, directory: backendRoot, jarPath: 'server.jar', javaCommand: settings.javaCommand, version: '', ...settings.backend };
  return settings;
}
javaCommand = getSettings().javaCommand;
function getStopCommand() { return getSettings().serverType === 'velocity' ? 'shutdown' : 'stop'; }
function launchMinecraft() {
  if (processChild) throw new Error('Server già avviato');
  if (!fs.existsSync(jarPath)) throw new Error(`JAR non trovato: ${relativeName(jarPath)}`);
  const settings = getSettings();
  setState('starting');
  logLine(`Avvio ${settings.serverType === 'velocity' ? 'Velocity' : 'Minecraft'} (${path.basename(jarPath)}) con -Xms${settings.minHeapMb}M -Xmx${settings.maxHeapMb}M`, 'system');
  const args = [`-Xms${settings.minHeapMb}M`, `-Xmx${settings.maxHeapMb}M`, '-jar', jarPath];
  if (settings.serverType !== 'velocity') args.push('nogui');
  const child = spawn(javaCommand, args, { cwd: serverRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  processChild = child;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => data.split(/\r?\n/).filter(Boolean).forEach(line => { parsePlayers(line); logLine(line); }));
  child.stderr.on('data', data => data.split(/\r?\n/).filter(Boolean).forEach(line => logLine(line, 'error')));
  child.once('spawn', () => { serverStartedAt = Date.now(); setState('online'); });
  child.once('error', error => { logLine(`Errore processo: ${error.message}`, 'error'); if (processChild === child) { processChild = null; serverStartedAt = null; setState('offline'); } });
  child.once('exit', (code, signal) => {
    logLine(`Processo terminato (code ${code ?? 'null'}, signal ${signal ?? 'none'})`, 'system');
    const shouldRestart = restartPending;
    restartPending = false;
    if (processChild === child) processChild = null;
    serverStartedAt = null;
    setState('offline');
    playerSnapshot = { online: 0, max: 0, names: [] };
    io.emit('server:players', playerSnapshot);
    if (shouldRestart) setTimeout(() => { try { launchMinecraft(); } catch (error) { logLine(`Riavvio fallito: ${error.message}`, 'error'); } }, 1500);
  });
}
function createBackupArchive(destination) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(destination, { flags: 'wx' });
    const archive = archiver('zip', { zlib: { level: 1 } });
    let settled = false;
    const fail = error => { if (settled) return; settled = true; fs.rmSync(destination, { force: true }); reject(error); };
    output.once('close', () => { if (!settled) { settled = true; resolve(archive.pointer()); } });
    output.once('error', fail);
    archive.once('error', fail);
    archive.pipe(output);
    archive.glob('**/*', { cwd: serverRoot, dot: true, ignore: ['logs/**', 'crash-reports/**'] });
    archive.finalize().catch(fail);
  });
}
async function runScheduledBackup() {
  const settings = getSettings();
  const intervalMs = settings.backupIntervalHours * 60 * 60 * 1000;
  if (!intervalMs || backupInProgress || Date.now() - Number(settings.lastBackupAt || 0) < intervalMs) return;
  backupInProgress = true;
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    if (processChild) {
      if (getSettings().serverType !== 'velocity') processChild.stdin.write('save-all flush\n');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    const backups = listBackups();
    if (backups.length >= 10) fs.rmSync(backupPath(backups[backups.length - 1].id), { force: true });
    const size = await createBackupArchive(backupPath(id));
    saveJson(SETTINGS_FILE, { ...getSettings(), lastBackupAt: Date.now() });
    logLine(`Backup automatico creato: ${id} (${size} byte)`, 'system');
  } catch (error) { logLine(`Backup automatico fallito: ${error.message}`, 'error'); }
  finally { backupInProgress = false; }
}
function extractBackupSafely(archivePath, destination) {
  return new Promise((resolve, reject) => {
    yauzl.open(archivePath, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      let settled = false;
      const fail = reason => { if (settled) return; settled = true; zip.close(); reject(reason); };
      zip.once('error', fail);
      zip.once('end', () => { if (!settled) { settled = true; resolve(); } });
      zip.on('entry', entry => {
        const name = entry.fileName.replace(/\\/g, '/');
        const parts = name.split('/').filter(Boolean);
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        const target = path.resolve(destination, ...parts);
        if (name.startsWith('/') || /^[a-zA-Z]:/.test(name) || parts.includes('..') || (mode & 0o170000) === 0o120000 || (target !== destination && !target.startsWith(`${destination}${path.sep}`))) return fail(new Error('Archivio non valido: percorso non sicuro'));
        if (entry.fileName.endsWith('/')) {
          try { fs.mkdirSync(target, { recursive: true }); zip.readEntry(); } catch (mkdirError) { fail(mkdirError); }
          return;
        }
        try { fs.mkdirSync(path.dirname(target), { recursive: true }); } catch (mkdirError) { return fail(mkdirError); }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError) return fail(streamError);
          const output = fs.createWriteStream(target, { flags: 'wx' });
          stream.once('error', fail);
          output.once('error', fail);
          output.once('finish', () => zip.readEntry());
          stream.pipe(output);
        });
      });
      zip.readEntry();
    });
  });
}

app.get('/api/bootstrap', (req, res) => {
  const user = currentUser(req);
  res.json({ setupRequired: users().length === 0, adminCreationEnabled: (process.env.ADMIN_CREATION_CODE || '').length >= 12, user: user ? publicUser(user) : null, state: serverState, serverName: path.basename(serverRoot), maxHeapMb });
});
app.post('/api/register', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  if (!safeName(username) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Nome utente non valido o password fuori dai limiti (12-128 caratteri)' });
  }
  const list = users();
  if (list.some(user => user.username.toLowerCase() === username.trim().toLowerCase())) return res.status(409).json({ error: 'Nome utente già registrato' });
  if (list.length > 0) {
    const creator = list.find(item => item.id === req.session.userId);
    if (!creator || creator.role !== 'admin') return res.status(403).json({ error: 'Solo un admin può creare altri account' });
  }
  const user = {
    id: crypto.randomUUID(), username: username.trim(), passwordHash: await bcrypt.hash(password, 12),
    role: list.length === 0 ? 'admin' : 'user', consoleAccess: false
  };
  list.push(user);
  saveJson(USERS_FILE, list);
  req.session.userId = user.id;
  res.status(201).json({ user: publicUser(user) });
});
app.post('/api/login', authLimiter, async (req, res) => {
  const { username, password } = req.body || {};
  const user = users().find(item => item.username.toLowerCase() === String(username || '').trim().toLowerCase());
  if (!user || typeof password !== 'string' || !await bcrypt.compare(password, user.passwordHash)) return res.status(401).json({ error: 'Credenziali non valide' });
  req.session.userId = user.id;
  res.json({ user: publicUser(user) });
});
app.post('/api/admins/register', adminSignupLimiter, async (req, res) => {
  const adminCode = process.env.ADMIN_CREATION_CODE;
  if (!adminCode || adminCode.length < 12) return res.status(503).json({ error: 'Creazione admin non configurata sul server' });
  const { username, password, code } = req.body || {};
  if (!secretMatches(code, adminCode)) return res.status(403).json({ error: 'Codice admin non valido' });
  if (!safeName(username) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Nome non valido o password fuori dai limiti (12-128 caratteri)' });
  }
  const list = users();
  if (list.some(user => user.username.toLowerCase() === username.trim().toLowerCase())) return res.status(409).json({ error: 'Nome utente già registrato' });
  const user = { id: crypto.randomUUID(), username: username.trim(), passwordHash: await bcrypt.hash(password, 12), role: 'admin', consoleAccess: true };
  list.push(user);
  saveJson(USERS_FILE, list);
  res.status(201).json({ user: publicUser(user) });
});
app.post('/api/logout', (req, res) => req.session.destroy(() => res.json({ ok: true })));
app.get('/api/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));
app.get('/api/users', requireAuth, requireAdmin, (req, res) => res.json({ users: users().map(publicUser) }));
app.post('/api/users', requireAuth, requireAdmin, async (req, res) => {
  const { username, password } = req.body || {};
  if (!safeName(username) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Nome utente non valido o password fuori dai limiti (12-128 caratteri)' });
  }
  const list = users();
  if (list.some(user => user.username.toLowerCase() === username.trim().toLowerCase())) return res.status(409).json({ error: 'Nome utente già registrato' });
  const user = { id: crypto.randomUUID(), username: username.trim(), passwordHash: await bcrypt.hash(password, 12), role: 'user', consoleAccess: false };
  list.push(user);
  saveJson(USERS_FILE, list);
  res.status(201).json({ user: publicUser(user) });
});
app.post('/api/admins', requireAuth, requireAdmin, authLimiter, async (req, res) => {
  const adminCode = process.env.ADMIN_CREATION_CODE;
  if (!adminCode || adminCode.length < 12) return res.status(503).json({ error: 'Configura ADMIN_CREATION_CODE in .env con almeno 12 caratteri e riavvia il pannello' });
  const { username, password, currentPassword, code } = req.body || {};
  if (!await bcrypt.compare(String(currentPassword || ''), req.user.passwordHash) || !secretMatches(code, adminCode)) {
    return res.status(403).json({ error: 'Password admin o codice di autorizzazione non validi' });
  }
  if (!safeName(username) || typeof password !== 'string' || password.length < 12 || password.length > 128) {
    return res.status(400).json({ error: 'Nome non valido o password fuori dai limiti (12-128 caratteri)' });
  }
  const list = users();
  if (list.some(user => user.username.toLowerCase() === username.trim().toLowerCase())) return res.status(409).json({ error: 'Nome utente già registrato' });
  const user = { id: crypto.randomUUID(), username: username.trim(), passwordHash: await bcrypt.hash(password, 12), role: 'admin', consoleAccess: true };
  list.push(user);
  saveJson(USERS_FILE, list);
  res.status(201).json({ user: publicUser(user) });
});
app.patch('/api/users/:id/console', requireAuth, requireAdmin, (req, res) => {
  const list = users();
  const target = list.find(user => user.id === req.params.id);
  if (!target || target.role === 'admin') return res.status(404).json({ error: 'Utente non trovato' });
  target.consoleAccess = Boolean(req.body?.allowed);
  saveJson(USERS_FILE, list);
  if (!target.consoleAccess) {
    for (const socket of io.sockets.sockets.values()) {
      if (socket.user?.id === target.id) socket.leave('console');
    }
  }
  res.json({ user: publicUser(target) });
});

app.get('/api/server', requireAuth, (req, res) => {
  const settings = getSettings();
  const availableJars = fs.readdirSync(serverRoot, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.jar')).map(entry => entry.name);
  const directoryEmpty = fs.readdirSync(serverRoot).length === 0;
  const jarExists = fs.existsSync(jarPath);
  res.json({ state: serverState, serverName: settings.serverName, serverVersion: settings.serverVersion, javaVersion: getJavaRuntime().version, serverType: settings.serverType, jar: path.basename(jarPath), jarExists, canCreateServer: !settings.serverName && directoryEmpty && !process.env.MC_SERVER_JAR, availableJars, minHeapMb: settings.minHeapMb, maxHeapMb: settings.maxHeapMb, backupIntervalHours: settings.backupIntervalHours, systemMemoryMb: Math.floor(os.totalmem() / 1024 / 1024), maxAllowedHeapMb: maxHeapMb });
});
app.get('/api/server/creation-options', requireAuth, requireAdmin, async (req, res) => {
  const software = String(req.query.software || 'paper');
  try {
    const [versions, javaRuntimes] = await Promise.all([getSoftwareVersions(software), Promise.resolve(getAvailableJavaRuntimes())]);
    res.json({ software, versions, javaRuntimes, selectedJavaCommand: javaCommand, eulaUrl: 'https://www.minecraft.net/eula' });
  } catch (error) { res.status(502).json({ error: `Catalogo software non disponibile: ${error.message}` }); }
});
app.post('/api/server/create', requireAuth, requireAdmin, serverCreateLimiter, async (req, res) => {
  if (processChild) return res.status(409).json({ error: 'Arresta il processo prima di creare il server' });
  if (getSettings().serverName) return res.status(409).json({ error: 'Esiste già un server configurato in questa directory' });
  if (process.env.MC_SERVER_JAR) return res.status(400).json({ error: 'Rimuovi MC_SERVER_JAR da .env per usare la creazione automatica, poi riavvia il pannello' });
  const { name, software, version, javaCommand: selectedJava, acceptEula, serverHostname: requestedHostname } = req.body || {};
  if (!safeName(name) || !['paper', 'vanilla', 'velocity'].includes(software) || typeof version !== 'string' || !/^[A-Za-z0-9._-]{1,32}$/.test(version)) {
    return res.status(400).json({ error: 'Nome, software o versione non validi' });
  }
  let serverHostname;
  try { serverHostname = normalizeServerHostname(requestedHostname); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (software !== 'velocity' && acceptEula !== true) return res.status(400).json({ error: 'Per creare il server Minecraft devi accettare la EULA ufficiale' });
  const runtime = getAvailableJavaRuntimes().find(candidate => candidate.command === selectedJava);
  if (!runtime) return res.status(400).json({ error: 'Il runtime Java selezionato non è installato o disponibile' });
  if (fs.readdirSync(serverRoot).length) return res.status(409).json({ error: 'La cartella server contiene già file. Scegli una cartella dedicata vuota prima di creare un server.' });
  const tempJar = path.join(serverRoot, `.server-${process.pid}-${crypto.randomBytes(4).toString('hex')}.download`);
  const jarName = 'server.jar';
  const destinationJar = path.join(serverRoot, jarName);
  const createdFiles = [];
  try {
    const versions = await getSoftwareVersions(software);
    if (!versions.includes(version)) return res.status(400).json({ error: 'La versione selezionata non è più disponibile nel catalogo ufficiale' });
    const artifact = await getServerArtifact(software, version);
    const size = await downloadServerArtifact(artifact, tempJar);
    fs.renameSync(tempJar, destinationJar);
    createdFiles.push(destinationJar);
    if (software !== 'velocity') {
      const eulaFile = path.join(serverRoot, 'eula.txt');
      fs.writeFileSync(eulaFile, `# Accepted by the server owner through Lantern on ${new Date().toISOString()}\neula=true\n`, { flag: 'wx' });
      createdFiles.push(eulaFile);
      const propertiesFile = path.join(serverRoot, 'server.properties');
      fs.writeFileSync(propertiesFile, `motd=${name}\nserver-port=25565\nmax-players=20\nonline-mode=true\n`, { flag: 'wx' });
      createdFiles.push(propertiesFile);
    }
    const settings = { ...getSettings(), serverName: name.trim(), serverVersion: artifact.label, serverHostname, serverType: software, javaCommand: runtime.command, jarPath: relativeName(destinationJar) };
    saveJson(SETTINGS_FILE, settings);
    jarPath = destinationJar;
    javaCommand = runtime.command;
    const localAddresses = Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal).map(item => item.address);
    const port = software === 'velocity' ? 25565 : 25565;
    const address = serverHostname ? `${serverHostname}${port === 25565 ? '' : `:${port}`}` : `${localAddresses[0] || '127.0.0.1'}:${port}`;
    res.status(201).json({ ok: true, name: name.trim(), software, version: artifact.label, jar: jarName, javaVersion: runtime.version, size, port, localAddresses, serverHostname, address, startRequired: true });
  } catch (error) {
    fs.rmSync(tempJar, { force: true });
    for (const file of createdFiles) fs.rmSync(file, { force: true });
    res.status(502).json({ error: `Creazione non riuscita: ${error.message}` });
  }
});
app.get('/api/metrics', requireAuth, (req, res) => res.json(captureMetrics()));
app.get('/api/server/details', requireAuth, requireAdmin, (req, res) => {
  const settings = getSettings();
  const configuration = getServerConfiguration(settings.serverType);
  const interfaces = Object.values(os.networkInterfaces()).flat().filter(item => item?.family === 'IPv4' && !item.internal).map(item => item.address);
  const bindAddress = settings.serverType === 'velocity' ? configuration.values.bind || '0.0.0.0:25565' : `${configuration.values['server-ip'] || '0.0.0.0'}:${configuration.values['server-port'] || '25565'}`;
  const serverPort = Number(bindAddress.match(/:(\d+)$/)?.[1] || 25565);
  const connectionHost = settings.serverHostname || interfaces[0] || '127.0.0.1';
  const connectionAddress = `${connectionHost}${serverPort === 25565 ? '' : `:${serverPort}`}`;
  res.json({
    serverName: settings.serverName, serverVersion: settings.serverVersion, serverHostname: settings.serverHostname, serverType: settings.serverType, state: serverState, directory: serverRoot, jar: path.basename(jarPath), jarExists: fs.existsSync(jarPath),
    java: getJavaRuntime(), memory: { minMb: settings.minHeapMb, maxMb: settings.maxHeapMb, hostTotalMb: Math.floor(os.totalmem() / 1024 / 1024) },
    process: { pid: processChild?.pid || null, uptimeSeconds: serverStartedAt ? Math.floor((Date.now() - serverStartedAt) / 1000) : 0 },
    network: { bindAddress, port: serverPort, serverHostname: settings.serverHostname, connectionAddress, localAddresses: interfaces }, configuration, players: playerSnapshot
  });
});
app.put('/api/server/address', requireAuth, requireAdmin, (req, res) => {
  let serverHostname;
  try { serverHostname = normalizeServerHostname(req.body?.hostname); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  const settings = { ...getSettings(), serverHostname };
  saveJson(SETTINGS_FILE, settings);
  const configuration = getServerConfiguration(settings.serverType);
  const bindAddress = settings.serverType === 'velocity' ? configuration.values.bind || '0.0.0.0:25565' : `${configuration.values['server-ip'] || '0.0.0.0'}:${configuration.values['server-port'] || '25565'}`;
  const port = Number(bindAddress.match(/:(\d+)$/)?.[1] || 25565);
  const localAddress = Object.values(os.networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal)?.address || '127.0.0.1';
  res.json({ serverHostname, address: serverHostname ? `${serverHostname}${port === 25565 ? '' : `:${port}`}` : `${localAddress}:${port}` });
});
app.put('/api/server/jar', requireAuth, requireAdmin, (req, res) => {
  if (processChild) return res.status(409).json({ error: 'Arresta il server prima di cambiare JAR' });
  const name = req.body?.jar;
  const serverType = req.body?.serverType === undefined ? getSettings().serverType : req.body.serverType;
  if (!['paper', 'vanilla', 'velocity'].includes(serverType)) return res.status(400).json({ error: 'Tipo software non valido' });
  if (typeof name !== 'string' || path.basename(name) !== name || !name.toLowerCase().endsWith('.jar')) return res.status(400).json({ error: 'Selezione JAR non valida' });
  try {
    const target = normalizeRelative(name);
    if (!fs.lstatSync(target).isFile()) return res.status(400).json({ error: 'Il JAR deve essere un file regolare nella root server' });
    jarPath = target;
    saveJson(SETTINGS_FILE, { ...getSettings(), jarPath: relativeName(target), serverType });
    res.json({ ok: true, jar: name, serverType });
  } catch (error) { res.status(400).json({ error: error.code === 'ENOENT' ? 'JAR non trovato' : error.message }); }
});
app.put('/api/settings', requireAuth, requireAdmin, (req, res) => {
  const { minHeapMb, maxHeapMb: requestedMax } = req.body || {};
  const nextMin = Number(minHeapMb);
  const nextMax = Number(requestedMax);
  const current = getSettings();
  const nextBackupInterval = req.body?.backupIntervalHours === undefined ? current.backupIntervalHours : Number(req.body.backupIntervalHours);
  if (!Number.isInteger(nextMin) || !Number.isInteger(nextMax) || nextMin < 512 || nextMax < nextMin || nextMax > maxHeapMb) {
    return res.status(400).json({ error: `RAM non valida: minimo 512 MB, massimo ${maxHeapMb} MB (75% della memoria rilevata)` });
  }
  if (![0, 6, 12, 24].includes(nextBackupInterval)) return res.status(400).json({ error: 'Intervallo backup non valido' });
  const nextSettings = { ...current, minHeapMb: nextMin, maxHeapMb: nextMax, backupIntervalHours: nextBackupInterval };
  if (nextBackupInterval !== current.backupIntervalHours) nextSettings.lastBackupAt = Date.now();
  saveJson(SETTINGS_FILE, nextSettings);
  res.json({ ok: true, minHeapMb: nextMin, maxHeapMb: nextMax, backupIntervalHours: nextBackupInterval });
});
app.post('/api/server/start', requireAuth, requireAdmin, (req, res) => {
  if (processChild) return res.status(409).json({ error: 'Server già avviato' });
  try {
    launchMinecraft();
    res.status(202).json({ ok: true });
  } catch (error) {
    processChild = null;
    setState('offline');
    res.status(500).json({ error: error.message });
  }
});
app.post('/api/server/restart', requireAuth, requireAdmin, (req, res) => {
  if (!processChild) {
    try { launchMinecraft(); return res.status(202).json({ ok: true, started: true }); }
    catch (error) { return res.status(400).json({ error: error.message }); }
  }
  if (restartPending) return res.status(409).json({ error: 'Riavvio già pianificato' });
  restartPending = true;
  setState('stopping');
  logLine('Riavvio controllato richiesto', 'system');
  processChild.stdin.write(`${getStopCommand()}\n`);
  res.json({ ok: true, restarting: true });
});
app.post('/api/server/stop', requireAuth, requireAdmin, (req, res) => {
  if (!processChild) return res.status(409).json({ error: 'Server non avviato' });
  processChild.stdin.write(`${getStopCommand()}\n`);
  setState('stopping');
  logLine('Comando stop inviato', 'system');
  res.json({ ok: true });
});
app.post('/api/server/players/refresh', requireAuth, (req, res) => {
  if (!canUseConsole(req.user)) return res.status(403).json({ error: 'Accesso console non concesso' });
  if (!processChild) return res.status(409).json({ error: 'Server offline' });
  processChild.stdin.write(`${getSettings().serverType === 'velocity' ? 'glist' : 'list'}\n`);
  res.json({ ok: true });
});
app.get('/api/backups', requireAuth, (req, res) => res.json({ backups: listBackups(), maxBackups: 10 }));
app.post('/api/backups', requireAuth, requireAdmin, async (req, res) => {
  if (listBackups().length >= 10) return res.status(409).json({ error: 'Limite di 10 backup raggiunto. Elimina un backup prima di crearne un altro.' });
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(4).toString('hex')}`;
  const destination = backupPath(id);
  try {
    if (processChild) {
      if (getSettings().serverType !== 'velocity') processChild.stdin.write('save-all flush\n');
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
    const size = await createBackupArchive(destination);
    res.status(201).json({ backup: { id, size, createdAt: new Date().toISOString() } });
  } catch (error) { res.status(500).json({ error: `Backup non riuscito: ${error.message}` }); }
});
app.get('/api/backups/:id/download', requireAuth, requireAdmin, (req, res) => {
  try {
    const file = backupPath(req.params.id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: 'Backup non trovato' });
    res.download(file, `${req.params.id}.zip`);
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/backups/:id', requireAuth, requireAdmin, (req, res) => {
  try { fs.rmSync(backupPath(req.params.id)); res.json({ ok: true }); }
  catch (error) { res.status(error.code === 'ENOENT' ? 404 : 400).json({ error: error.code === 'ENOENT' ? 'Backup non trovato' : error.message }); }
});
app.post('/api/backups/:id/restore', requireAuth, requireAdmin, async (req, res) => {
  if (processChild) return res.status(409).json({ error: 'Arresta il server prima di ripristinare un backup' });
  if (path.parse(serverRoot).root === serverRoot || !fs.lstatSync(serverRoot).isDirectory()) return res.status(400).json({ error: 'La directory server non può essere sostituita in sicurezza' });
  let source;
  try { source = backupPath(req.params.id); }
  catch (error) { return res.status(400).json({ error: error.message }); }
  if (!fs.existsSync(source)) return res.status(404).json({ error: 'Backup non trovato' });
  const parent = path.dirname(serverRoot);
  const token = crypto.randomUUID();
  const staging = path.join(parent, `.${path.basename(serverRoot)}-restore-${token}`);
  const previous = path.join(parent, `.${path.basename(serverRoot)}-previous-${token}`);
  try {
    fs.mkdirSync(staging);
    await extractBackupSafely(source, staging);
    fs.renameSync(serverRoot, previous);
    try { fs.renameSync(staging, serverRoot); }
    catch (error) { fs.renameSync(previous, serverRoot); throw error; }
    fs.rmSync(previous, { recursive: true, force: true });
    if (!fs.existsSync(jarPath)) jarPath = path.join(serverRoot, 'server.jar');
    res.json({ ok: true, message: 'Backup ripristinato. Il server resta spento.' });
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    res.status(400).json({ error: `Ripristino non riuscito: ${error.message}` });
  }
});
app.post('/api/console', requireAuth, (req, res) => {
  if (!canUseConsole(req.user)) return res.status(403).json({ error: 'Accesso console non concesso' });
  const command = typeof req.body?.command === 'string' ? req.body.command.trim() : '';
  if (!command || command.length > 500 || /[\r\n\0]/.test(command)) return res.status(400).json({ error: 'Comando non valido' });
  if (!processChild) return res.status(409).json({ error: 'Server offline' });
  processChild.stdin.write(`${command}\n`);
  logLine(`> ${req.user.username}: ${command}`, 'command');
  res.json({ ok: true });
});

app.get('/api/files', requireAuth, (req, res) => {
  try {
    const target = normalizeRelative(req.query.path || '.');
    const stat = fs.statSync(target);
    if (!stat.isDirectory()) return res.status(400).json({ error: 'Non è una cartella' });
    const entries = fs.readdirSync(target, { withFileTypes: true }).map(entry => {
      const absolute = path.join(target, entry.name);
      const info = fs.statSync(absolute);
      return { name: entry.name, path: relativeName(absolute), directory: entry.isDirectory(), size: info.size, modifiedAt: info.mtime.toISOString() };
    }).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
    res.json({ path: relativeName(target), parent: target === serverRoot ? null : relativeName(path.dirname(target)), entries });
  } catch (error) { res.status(400).json({ error: error.code === 'ENOENT' ? 'Percorso non trovato' : error.message }); }
});
app.get('/api/files/content', requireAuth, (req, res) => {
  try {
    const target = normalizeRelative(req.query.path);
    const stat = fs.statSync(target);
    if (!stat.isFile() || stat.size > 1024 * 1024) return res.status(400).json({ error: 'File non valido o superiore a 1 MB' });
    const content = fs.readFileSync(target);
    if (content.includes(0)) return res.status(415).json({ error: 'File binario non modificabile' });
    res.json({ path: relativeName(target), content: content.toString('utf8') });
  } catch (error) { res.status(400).json({ error: error.code === 'ENOENT' ? 'File non trovato' : error.message }); }
});
app.put('/api/files/content', requireAuth, requireAdmin, (req, res) => {
  try {
    const target = normalizeRelative(req.body?.path);
    const content = req.body?.content;
    if (typeof content !== 'string' || Buffer.byteLength(content) > 1024 * 1024) return res.status(400).json({ error: 'Contenuto non valido o superiore a 1 MB' });
    fs.writeFileSync(target, content, { flag: 'w' });
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.post('/api/files', requireAuth, requireAdmin, (req, res) => {
  try {
    const target = normalizeRelative(req.body?.path);
    if (fs.existsSync(target)) return res.status(409).json({ error: 'Il percorso esiste già' });
    if (req.body?.directory) fs.mkdirSync(target, { recursive: false });
    else fs.writeFileSync(target, '', { flag: 'wx' });
    res.status(201).json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.message }); }
});
app.delete('/api/files', requireAuth, requireAdmin, (req, res) => {
  try {
    const target = normalizeRelative(req.body?.path);
    if (target === serverRoot) return res.status(400).json({ error: 'Non puoi eliminare la root del server' });
    fs.rmSync(target, { recursive: true, force: false });
    res.json({ ok: true });
  } catch (error) { res.status(400).json({ error: error.code === 'ENOENT' ? 'Percorso non trovato' : error.message }); }
});

const upload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
app.post('/api/plugins/upload', requireAuth, requireAdmin, upload.single('plugin'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Seleziona un file JAR' });
  if (!req.file.originalname.toLowerCase().endsWith('.jar')) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(400).json({ error: 'Sono ammessi solo file .jar' });
  }
  const pluginsDir = path.join(serverRoot, 'plugins');
  fs.mkdirSync(pluginsDir, { recursive: true });
  const safeFilename = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._ -]/g, '_');
  const destination = path.join(pluginsDir, safeFilename);
  if (fs.existsSync(destination)) {
    fs.rmSync(req.file.path, { force: true });
    return res.status(409).json({ error: 'Esiste già un plugin con questo nome' });
  }
  fs.renameSync(req.file.path, destination);
  res.status(201).json({ ok: true, name: safeFilename, restartRequired: Boolean(processChild) });
});
const serverJarUpload = multer({ dest: path.join(DATA_DIR, 'uploads'), limits: { fileSize: 2 * 1024 * 1024 * 1024, files: 1 } });
app.post('/api/server/jars/upload', requireAuth, requireAdmin, serverJarUpload.single('serverJar'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Seleziona un file JAR del server' });
  if (processChild) {
    await fs.promises.rm(req.file.path, { force: true });
    return res.status(409).json({ error: 'Arresta il server prima di caricare un nuovo JAR' });
  }
  if (!req.file.originalname.toLowerCase().endsWith('.jar')) {
    await fs.promises.rm(req.file.path, { force: true });
    return res.status(400).json({ error: 'Sono ammessi solo file .jar' });
  }
  const filename = path.basename(req.file.originalname).replace(/[^a-zA-Z0-9._ -]/g, '_');
  const destination = path.join(serverRoot, filename);
  try {
    await fs.promises.copyFile(req.file.path, destination, fs.constants.COPYFILE_EXCL);
    await fs.promises.rm(req.file.path, { force: true });
    res.status(201).json({ ok: true, name: filename });
  } catch (error) {
    await fs.promises.rm(req.file.path, { force: true });
    res.status(error.code === 'EEXIST' ? 409 : 500).json({ error: error.code === 'EEXIST' ? 'Esiste già un file con questo nome' : `Upload non riuscito: ${error.message}` });
  }
});

io.use((socket, next) => {
  const user = users().find(item => item.id === socket.request.session?.userId);
  if (!user) return next(new Error('Autenticazione richiesta'));
  socket.user = publicUser(user);
  next();
});
io.on('connection', socket => {
  socket.emit('server:state', serverState);
  socket.emit('server:metrics', captureMetrics());
  socket.emit('server:players', playerSnapshot);
  socket.on('console:join', () => {
    const user = users().find(item => item.id === socket.user.id);
    if (!canUseConsole(user)) return socket.emit('console:error', 'Accesso console non concesso');
    socket.user = publicUser(user);
    socket.join('console');
    socket.emit('console:history', consoleHistory);
  });
  socket.on('console:command', command => {
    const user = users().find(item => item.id === socket.user.id);
    if (!canUseConsole(user) || typeof command !== 'string' || !processChild || !command.trim() || command.length > 500 || /[\r\n\0]/.test(command)) return;
    processChild.stdin.write(`${command.trim()}\n`);
    logLine(`> ${user.username}: ${command.trim()}`, 'command');
  });
});

const metricsTimer = setInterval(() => io.emit('server:metrics', captureMetrics()), 5000);
metricsTimer.unref();
const backupTimer = setInterval(runScheduledBackup, 60 * 1000);
PORT = process.env.PORT || 3000;
HOST = '0.0.0.0';

httpServer.listen(PORT, HOST, () => {
    console.log(`Minecraft panel attivo su http://${HOST}:${PORT}`);
    console.log(`Minecraft server directory: ${serverRoot}`);
    if (!process.env.SESSION_SECRET) {
        console.warn("SESSION_SECRET non impostata: le sessioni verranno invalidate a ogni riavvio.");
    }
});