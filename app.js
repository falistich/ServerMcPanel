'use strict';

const $ = selector => document.querySelector(selector);
const authView = $('#auth-view');
const appView = $('#app-view');
const authForm = $('#auth-form');
let me = null;
let socket = null;
let currentPath = '.';
let selectedFile = null;
let consoleJoined = false;
let toastTimer;
let serverType = 'paper';
let jarAvailable = false;
let serverNameConfigured = false;
let canCreateServer = false;

async function api(url, options = {}) {
  const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) } });
  const payload = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Richiesta fallita (${response.status})`);
  return payload;
}
function notify(message, isError = false) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3400);
}
function setButtonBusy(button, busy, text) {
  button.disabled = busy;
  if (text) button.dataset.original = button.dataset.original || button.innerHTML;
  if (busy && text) button.textContent = text;
  else if (!busy && button.dataset.original) button.innerHTML = button.dataset.original;
}
function showAuth(setupRequired, adminCreationEnabled = false) {
  appView.hidden = true;
  authView.hidden = false;
  $('#auth-eyebrow').textContent = setupRequired ? 'CONFIGURAZIONE INIZIALE' : 'ACCESSO PRIVATO';
  $('#auth-title').innerHTML = setupRequired ? 'Il primo passo.' : 'Bentornato.';
  $('#auth-description').textContent = setupRequired ? 'Crea l’account amministratore del pannello.' : 'Entra nella console del tuo server.';
  $('#auth-submit').innerHTML = setupRequired ? 'Crea account admin <span>→</span>' : 'Accedi <span>→</span>';
  $('#auth-note').textContent = setupRequired ? 'La prima registrazione diventa amministratore.' : 'Pannello privato · accesso locale';
  $('#admin-create-open').hidden = !adminCreationEnabled;
  authForm.dataset.setup = String(setupRequired);
  authForm.elements.password.autocomplete = setupRequired ? 'new-password' : 'current-password';
  authForm.elements.username.focus();
}
function showApp(user) {
  me = user;
  authView.hidden = true;
  appView.hidden = false;
  $('#username-label').textContent = user.username;
  $('#avatar').textContent = user.username.charAt(0).toUpperCase();
  $('#role-label').textContent = user.role === 'admin' ? 'ADMIN' : 'USER';
  document.querySelectorAll('.admin-only').forEach(element => { element.hidden = user.role !== 'admin'; });
  $('#console-access-dot').classList.toggle('granted', user.consoleAccess);
  $('#refresh-players').disabled = !user.consoleAccess;
  $('#date-label').textContent = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long' }).format(new Date()).toUpperCase();
  connectSocket();
  loadServer();
  loadMetrics();
  if (user.role === 'admin') loadServerDetails();
  loadFiles('.');
  loadSoftware();
  loadBackups();
  loadPlugins();
  if (user.role === 'admin') loadUsers();
}
function connectSocket() {
  if (socket) socket.disconnect();
  socket = io({ withCredentials: true });
  socket.on('connect', () => {
    consoleJoined = false;
    if (document.querySelector('#view-console').classList.contains('active')) joinConsole();
  });
  socket.on('disconnect', () => { consoleJoined = false; });
  socket.on('server:state', setState);
  socket.on('server:metrics', renderMetrics);
  socket.on('server:players', renderPlayers);
  socket.on('console:history', entries => { $('#console-output').replaceChildren(); entries.forEach(appendLog); });
  socket.on('console:line', appendLog);
  socket.on('console:error', message => notify(message, true));
  socket.on('connect_error', () => notify('Connessione live non disponibile. Ricarica la pagina.', true));
}
async function loadServer() {
  try {
    const data = await api('/api/server');
    serverType = data.serverType;
    jarAvailable = data.jarExists;
    serverNameConfigured = Boolean(data.serverName);
    canCreateServer = data.canCreateServer;
    const displayName = data.serverName || data.jar.replace(/\.jar$/i, '') || 'Minecraft server';
    $('#sidebar-server').textContent = document.title = displayName;
    $('#console-caption').textContent = `${$('#sidebar-server').textContent} / console`;
    $('#jar-name').textContent = data.jar;
    $('#heap-min').value = data.minHeapMb;
    $('#heap-max').value = data.maxHeapMb;
    $('#heap-min').max = data.maxAllowedHeapMb;
    $('#heap-max').max = data.maxAllowedHeapMb;
    $('#heap-cap').textContent = `max rilevato: ${data.maxAllowedHeapMb.toLocaleString('it-IT')} MB`;
    $('#backup-interval').value = String(data.backupIntervalHours);
    $('#host-name').textContent = `${data.systemMemoryMb.toLocaleString('it-IT')} MB RAM`;
    updateMemoryMeter(data.maxAllowedHeapMb);
    setState(data.state);
  } catch (error) { notify(error.message, true); }
}
function setState(state) {
  const labels = { online: ['Online', 'Processo Java attivo', 'ONLINE'], offline: ['Spento', 'In attesa di avvio', 'OFFLINE'], starting: ['Avvio in corso', 'Attendere il log di avvio', 'AVVIO'], stopping: ['Arresto in corso', 'Chiusura controllata', 'ARRESTO'] };
  const [title, detail, pill] = labels[state] || labels.offline;
  $('#status-title').textContent = title;
  $('#status-detail').textContent = detail;
  $('#status-pill span').textContent = pill;
  $('#console-status span').textContent = pill;
  $('#status-pill').dataset.state = state;
  $('#console-status').dataset.state = state;
  $('#status-orb').className = `status-orb ${state}`;
  $('#start-button').hidden = state !== 'offline';
  $('#create-server-button').hidden = !canCreateServer || state !== 'offline';
  $('#stop-button').hidden = state === 'offline';
  $('#stop-button').disabled = state === 'stopping';
  $('#start-button').disabled = !jarAvailable || state !== 'offline';
  $('#start-hint').hidden = jarAvailable || canCreateServer || state !== 'offline';
  $('#start-hint-text').textContent = serverNameConfigured ? 'JAR server non trovato' : 'Configura MC_SERVER_JAR o carica un JAR';
  $('#start-hint-action').hidden = serverNameConfigured || canCreateServer;
  $('#restart-button').hidden = state !== 'online';
  $('#software-status span').textContent = pill;
  $('#software-status').dataset.state = state;
  $('#active-jar-state').textContent = state === 'offline' ? 'Pronto per l’avvio' : 'Modifiche al JAR disponibili dopo l’arresto';
  $('#software-kind').textContent = serverType === 'velocity' ? 'VELOCITY PROXY' : serverType === 'vanilla' ? 'VANILLA' : 'PAPER';
  $('#velocity-requirement').hidden = serverType !== 'velocity';
  $('#command-input').disabled = state !== 'online' || !me?.consoleAccess;
  $('#command-input').placeholder = !me?.consoleAccess ? 'Accesso console non concesso' : state !== 'online' ? 'Avvia il processo per inviare comandi...' : serverType === 'velocity' ? 'Scrivi un comando Velocity...' : 'Scrivi un comando Minecraft...';
}
function updateMemoryMeter(maximum) {
  const value = Number($('#heap-max').value) || 0;
  $('#memory-progress').style.width = `${Math.min(100, Math.max(0, value / maximum * 100))}%`;
}
async function loadMetrics() {
  try { renderMetrics(await api('/api/metrics')); } catch {}
}
async function loadServerDetails() {
  try {
    const data = await api('/api/server/details');
    const formatUptime = seconds => {
      const days = Math.floor(seconds / 86400);
      const hours = Math.floor(seconds % 86400 / 3600);
      const minutes = Math.floor(seconds % 3600 / 60);
      return `${days ? `${days}g ` : ''}${hours}h ${minutes}m`;
    };
    $('#detail-name').textContent = data.serverName || 'Non creato';
    $('#detail-version').textContent = data.serverVersion || '--';
    $('#detail-type').textContent = data.serverType === 'velocity' ? 'Velocity proxy' : data.serverType === 'vanilla' ? 'Vanilla' : 'Paper';
    $('#detail-jar').textContent = `${data.jar}${data.jarExists ? '' : ' (mancante)'}`;
    $('#detail-java').textContent = data.java.available ? data.java.version : `Non disponibile (${data.java.version})`;
    $('#detail-java-executable').textContent = data.java.executable;
    $('#detail-memory').textContent = `${data.memory.minMb} MB min · ${data.memory.maxMb} MB max`;
    $('#detail-pid').textContent = data.process.pid ? `PID ${data.process.pid}` : 'Non avviato';
    $('#detail-uptime').textContent = `Uptime: ${formatUptime(data.process.uptimeSeconds)}`;
    $('#detail-directory').textContent = data.directory;
    $('#detail-endpoint').textContent = `${data.network.bindAddress} (porta ${data.network.port})`;
    $('#detail-addresses').textContent = data.network.connectionAddress;
    $('.address-info-row span').textContent = data.network.serverHostname ? 'Dominio da condividere' : 'Indirizzo LAN da condividere';
    $('#server-hostname').value = data.network.serverHostname || '';
    let lanAddresses = $('#detail-lan-addresses');
    if (!lanAddresses) {
      const lanRow = document.createElement('div'); lanRow.className = 'server-info-row';
      const label = document.createElement('span'); label.textContent = 'Indirizzi LAN';
      lanAddresses = document.createElement('strong'); lanAddresses.id = 'detail-lan-addresses';
      lanRow.append(label, lanAddresses);
      $('.address-info-row').after(lanRow);
    }
    lanAddresses.textContent = data.network.localAddresses.length ? data.network.localAddresses.map(ip => `${ip}:${data.network.port}`).join(', ') : `127.0.0.1:${data.network.port} (solo questo PC)`;
    $('.network-help').textContent = data.network.serverHostname
      ? `Hostname salvato come indirizzo da condividere. Verifica che il DNS A/AAAA punti al tuo IP pubblico${data.network.port === 25565 ? '' : ` e configura un record SRV verso la porta ${data.network.port}`}; inoltra la porta del proxy/server sul router.`
      : 'L’indirizzo LAN funziona solo sulla stessa rete. Per amici fuori casa imposta un dominio qui, crea il record DNS A/AAAA verso il tuo IP pubblico e inoltra la porta sul router.';
    $('#detail-players').textContent = `${data.players.online} / ${data.players.max}${data.players.names.length ? ` · ${data.players.names.join(', ')}` : ''}`;
    $('#detail-config-title').textContent = data.configuration.exists ? data.configuration.file : `${data.configuration.file} (non ancora generato)`;
    renderDetailTable($('#detail-config'), data.configuration.values);
    const backends = Object.entries(data.configuration.backends);
    $('#detail-backends-wrap').hidden = !backends.length;
    renderDetailTable($('#detail-backends'), Object.fromEntries(backends));
  } catch (error) { notify(error.message, true); }
}
function renderDetailTable(container, values) {
  container.replaceChildren();
  const entries = Object.entries(values);
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'muted';
    empty.textContent = 'Nessuna impostazione disponibile.';
    container.append(empty);
    return;
  }
  entries.forEach(([key, value]) => {
    const row = document.createElement('div'); row.className = 'server-info-row';
    const label = document.createElement('span'); label.textContent = key;
    const content = document.createElement('strong'); content.textContent = value;
    row.append(label, content); container.append(row);
  });
}
function renderMetrics(metrics) {
  const toGb = bytes => (bytes / 1024 ** 3).toFixed(1);
  const usedMemory = metrics.memory.totalBytes - metrics.memory.freeBytes;
  const memoryPercent = Math.round(usedMemory / metrics.memory.totalBytes * 100);
  $('#metric-cpu').textContent = `${metrics.cpuPercent}%`;
  $('#metric-cpu-bar').style.width = `${metrics.cpuPercent}%`;
  $('#metric-memory').textContent = `${toGb(usedMemory)} / ${toGb(metrics.memory.totalBytes)} GB`;
  $('#metric-memory-bar').style.width = `${memoryPercent}%`;
  $('#metric-memory-detail').textContent = `${memoryPercent}% in uso · memoria host`;
  if (metrics.disk) {
    const usedDisk = metrics.disk.totalBytes - metrics.disk.freeBytes;
    const diskPercent = Math.round(usedDisk / metrics.disk.totalBytes * 100);
    $('#metric-disk').textContent = `${toGb(usedDisk)} / ${toGb(metrics.disk.totalBytes)} GB`;
    $('#metric-disk-bar').style.width = `${diskPercent}%`;
    $('#metric-disk-detail').textContent = `${diskPercent}% occupato · volume server`;
  } else {
    $('#metric-disk').textContent = 'Non disponibile';
    $('#metric-disk-bar').style.width = '0%';
    $('#metric-disk-detail').textContent = 'Volume non rilevato';
  }
  $('#metrics-updated').textContent = `Aggiornato ${new Date(metrics.capturedAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
  renderPlayers(metrics.players);
}
function renderPlayers(snapshot) {
  if (!snapshot) return;
  $('#player-count').textContent = `${snapshot.online} / ${snapshot.max}`;
  const container = $('#player-list');
  container.replaceChildren();
  if (!snapshot.online) {
    const empty = document.createElement('span');
    empty.className = 'player-empty';
    empty.textContent = $('#status-pill').dataset.state === 'offline' ? 'Avvia il server per rilevare i giocatori.' : 'Nessun giocatore online.';
    container.append(empty);
    return;
  }
  snapshot.names.forEach(player => {
    const item = document.createElement('span');
    item.className = 'player-chip';
    item.textContent = player;
    container.append(item);
  });
}
async function loadSoftware() {
  try {
    const data = await api('/api/server');
    serverType = data.serverType;
    $('#active-jar').textContent = data.jar;
    $('#software-type').value = data.serverType;
    $('#software-type').disabled = data.state !== 'offline' || me.role !== 'admin';
    const select = $('#jar-select');
    select.replaceChildren();
    const jars = [...new Set([data.jar, ...data.availableJars])];
    if (!jars.length) jars.push('server.jar');
    jars.forEach(jar => { const option = document.createElement('option'); option.value = jar; option.textContent = jar; option.selected = jar === data.jar; select.append(option); });
    select.disabled = !data.availableJars.length || data.state !== 'offline';
    $('#save-jar').disabled = select.disabled || $('#software-type').disabled || me.role !== 'admin';
    $('#software-kind').textContent = data.serverType === 'velocity' ? 'VELOCITY PROXY' : data.serverType === 'vanilla' ? 'VANILLA' : 'PAPER';
    $('#velocity-requirement').hidden = data.serverType !== 'velocity';
    $('#server-jar-file').disabled = data.state !== 'offline';
  } catch (error) { notify(error.message, true); }
}
function updateCreationSoftwareFields(software) {
  const isVelocity = software === 'velocity';
  $('#eula-label').hidden = isVelocity;
  $('#server-create-eula').required = !isVelocity;
  $('#server-create-eula').checked = false;
  $('#server-create-velocity-note').hidden = !isVelocity;
  $('#server-create-version-label').firstChild.textContent = isVelocity ? 'Versione Velocity' : 'Versione Minecraft';
}
async function loadCreationOptions(software) {
  const versions = $('#server-create-version');
  versions.disabled = true;
  versions.replaceChildren(new Option('Caricamento catalogo...', ''));
  $('#server-create-error').textContent = '';
  try {
    const data = await api(`/api/server/creation-options?software=${encodeURIComponent(software)}`);
    versions.replaceChildren();
    data.versions.forEach((version, index) => versions.add(new Option(version, version, index === 0, index === 0)));
    versions.disabled = !data.versions.length;
    const javaSelect = $('#server-create-java');
    javaSelect.replaceChildren();
    data.javaRuntimes.forEach(runtime => {
      const option = new Option(`Java ${runtime.version}`, runtime.command, runtime.command === data.selectedJavaCommand, runtime.command === data.selectedJavaCommand);
      option.dataset.version = runtime.version;
      javaSelect.add(option);
    });
    if (!data.javaRuntimes.length) {
      javaSelect.add(new Option('Nessun runtime Java trovato', ''));
      javaSelect.disabled = true;
      $('#server-create-submit').disabled = true;
      $('#server-create-java-note').textContent = 'Installa Java e configura JAVA_COMMAND in .env.';
    } else {
      javaSelect.disabled = false;
      $('#server-create-submit').disabled = false;
      $('#server-create-java-note').textContent = 'Scegli uno dei runtime Java installati sul computer.';
    }
  } catch (error) {
    versions.replaceChildren(new Option('Catalogo non disponibile', ''));
    $('#server-create-error').textContent = error.message;
  }
}
async function createServer() {
  const button = $('#server-create-submit');
  setButtonBusy(button, true, 'Download e verifica JAR...');
  $('#server-create-error').textContent = '';
  try {
    const result = await api('/api/server/create', { method: 'POST', body: JSON.stringify({
      name: $('#server-create-name').value.trim(),
      software: $('#server-create-software').value,
      version: $('#server-create-version').value,
      javaCommand: $('#server-create-java').value,
      serverHostname: $('#server-create-hostname')?.value.trim() || '',
      acceptEula: $('#server-create-eula').checked
    }) });
    $('#server-create-dialog').close();
    $('#server-create-form').reset();
    await Promise.all([loadServer(), loadSoftware(), loadServerDetails(), loadFiles('.')]);
    notify(`Server ${result.name} creato. Avvialo, poi connettiti a ${result.address}${result.serverHostname ? ' dopo aver configurato il DNS' : ' dalla LAN'}.`, false);
  } catch (error) { $('#server-create-error').textContent = error.message; }
  finally { setButtonBusy(button, false); }
}
async function loadBackups() {
  try {
    const { backups, maxBackups } = await api('/api/backups');
    const list = $('#backup-list');
    list.replaceChildren();
    if (!backups.length) {
      const empty = document.createElement('p'); empty.className = 'muted backup-empty'; empty.textContent = 'Non ci sono backup. Crea il primo snapshot del server.'; list.append(empty); return;
    }
    backups.forEach(backup => {
      const row = document.createElement('div'); row.className = 'backup-row';
      const file = document.createElement('div'); file.className = 'backup-file';
      const icon = document.createElement('span'); icon.className = 'backup-icon'; icon.textContent = '▤';
      const name = document.createElement('strong'); name.textContent = `snapshot-${backup.id}.zip`; file.append(icon, name);
      const size = document.createElement('span'); size.className = 'backup-size'; size.textContent = formatSize(backup.size);
      const date = document.createElement('time'); date.textContent = new Date(backup.createdAt).toLocaleString('it-IT');
      const actions = document.createElement('div'); actions.className = 'backup-actions';
      if (me.role === 'admin') {
        const download = document.createElement('a'); download.className = 'icon-button'; download.href = `/api/backups/${encodeURIComponent(backup.id)}/download`; download.title = 'Scarica backup'; download.setAttribute('aria-label', 'Scarica backup'); download.textContent = '↓';
        const restore = document.createElement('button'); restore.className = 'icon-button'; restore.title = 'Ripristina backup'; restore.setAttribute('aria-label', 'Ripristina backup'); restore.textContent = '↶'; restore.addEventListener('click', () => restoreBackup(backup));
        const remove = document.createElement('button'); remove.className = 'icon-button backup-remove'; remove.title = 'Elimina backup'; remove.setAttribute('aria-label', 'Elimina backup'); remove.textContent = '×'; remove.addEventListener('click', () => deleteBackup(backup));
        actions.append(download, restore, remove);
      }
      row.append(file, size, date, actions); list.append(row);
    });
    $('#create-backup').disabled = me.role !== 'admin' || backups.length >= maxBackups;
  } catch (error) { $('#backup-list').textContent = error.message; }
}
async function createBackup() {
  const button = $('#create-backup'); setButtonBusy(button, true, 'Snapshot in corso...');
  try { const { backup } = await api('/api/backups', { method: 'POST' }); notify(`Backup creato · ${formatSize(backup.size)}`); await loadBackups(); }
  catch (error) { notify(error.message, true); }
  finally { setButtonBusy(button, false); }
}
async function restoreBackup(backup) {
  if (!window.confirm(`Ripristinare ${backup.id}? La cartella server attuale verrà sostituita. Il server deve essere spento.`)) return;
  try { const result = await api(`/api/backups/${encodeURIComponent(backup.id)}/restore`, { method: 'POST' }); notify(result.message); await loadServer(); await loadFiles('.'); await loadSoftware(); }
  catch (error) { notify(error.message, true); }
}
async function deleteBackup(backup) {
  if (!window.confirm(`Eliminare il backup ${backup.id}?`)) return;
  try { await api(`/api/backups/${encodeURIComponent(backup.id)}`, { method: 'DELETE' }); notify('Backup eliminato'); await loadBackups(); }
  catch (error) { notify(error.message, true); }
}
function openView(viewName) {
  document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `view-${viewName}`));
  document.querySelectorAll('.nav-item').forEach(button => button.classList.toggle('active', button.dataset.view === viewName));
  $('#crumb').textContent = ({ overview: 'PANORAMICA', details: 'DATI SERVER', console: 'CONSOLE', files: 'FILE MANAGER', software: 'SOFTWARE', plugins: 'PLUGIN', backups: 'BACKUP', users: 'ACCESSI' })[viewName] || 'PANORAMICA';
  if (viewName === 'details' && me.role === 'admin') loadServerDetails();
  if (viewName === 'console') joinConsole();
  if (viewName === 'files') loadFiles(currentPath);
  if (viewName === 'plugins') loadPlugins();
  if (viewName === 'software') loadSoftware();
  if (viewName === 'backups') loadBackups();
  if (viewName === 'users' && me.role === 'admin') loadUsers();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}
function joinConsole() {
  if (!me?.consoleAccess || !socket?.connected || consoleJoined) return;
  socket.emit('console:join');
  consoleJoined = true;
}
function appendLog(entry) {
  const output = $('#console-output');
  const row = document.createElement('div');
  row.className = `log-row ${entry.type || 'output'}`;
  const time = document.createElement('time');
  time.textContent = new Date(entry.at || Date.now()).toLocaleTimeString('it-IT', { hour12: false });
  const text = document.createElement('span');
  text.textContent = entry.line;
  row.append(time, text);
  output.append(row);
  while (output.children.length > 500) output.firstElementChild.remove();
  output.scrollTop = output.scrollHeight;
  if (entry.type === 'system' || entry.type === 'error') addActivity(entry);
}
function addActivity(entry) {
  const list = $('#recent-activity');
  const empty = list.querySelector('.empty-activity');
  if (empty) empty.remove();
  const row = document.createElement('div');
  row.className = 'activity-row';
  const marker = document.createElement('i');
  marker.className = entry.type === 'error' ? 'activity-marker error' : 'activity-marker';
  const text = document.createElement('span');
  text.textContent = entry.line;
  const time = document.createElement('time');
  time.textContent = new Date(entry.at || Date.now()).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  row.append(marker, text, time);
  list.prepend(row);
  while (list.children.length > 6) list.lastElementChild.remove();
}
function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
async function loadFiles(directory) {
  currentPath = directory;
  try {
    const data = await api(`/api/files?path=${encodeURIComponent(directory)}`);
    currentPath = data.path;
    renderBreadcrumbs(data.path);
    const list = $('#file-list');
    list.replaceChildren();
    if (data.parent !== null) {
      const up = document.createElement('button');
      up.className = 'file-entry parent-entry';
      up.innerHTML = '<span class="file-type-icon folder">↰</span><span class="file-entry-name">..</span><span class="file-entry-size">SU</span>';
      up.addEventListener('click', () => loadFiles(data.parent));
      list.append(up);
    }
    if (!data.entries.length) list.innerHTML = '<div class="file-empty">Cartella vuota</div>';
    data.entries.forEach(entry => {
      const row = document.createElement('div');
      row.className = `file-entry ${selectedFile === entry.path ? 'selected' : ''}`;
      const open = document.createElement('button');
      open.className = 'file-entry-open';
      const icon = document.createElement('span');
      icon.className = `file-type-icon ${entry.directory ? 'folder' : 'document'}`;
      icon.textContent = entry.directory ? '▰' : fileIcon(entry.name);
      const name = document.createElement('span');
      name.className = 'file-entry-name';
      name.textContent = entry.name;
      const size = document.createElement('span');
      size.className = 'file-entry-size';
      size.textContent = entry.directory ? 'DIR' : formatSize(entry.size);
      open.append(icon, name, size);
      open.addEventListener('click', () => entry.directory ? loadFiles(entry.path) : openFile(entry));
      row.append(open);
      if (me.role === 'admin') {
        const remove = document.createElement('button');
        remove.className = 'file-delete';
        remove.title = `Elimina ${entry.name}`;
        remove.textContent = '×';
        remove.addEventListener('click', () => deleteFile(entry));
        row.append(remove);
      }
      list.append(row);
    });
  } catch (error) { $('#file-list').innerHTML = `<p class="file-empty">${escapeHtml(error.message)}</p>`; }
}
function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  return ({ properties: '⚙', json: '{}', yml: '≡', yaml: '≡', txt: 'T', log: '≋' })[ext] || '·';
}
function renderBreadcrumbs(directory) {
  const container = $('#breadcrumbs');
  container.replaceChildren();
  const root = document.createElement('button');
  root.textContent = 'SERVER';
  root.addEventListener('click', () => loadFiles('.'));
  container.append(root);
  let accumulated = '';
  const parts = directory === '.' ? [] : directory.split('/');
  parts.forEach((part, index) => {
    const separator = document.createElement('span'); separator.textContent = '/';
    const button = document.createElement('button'); button.textContent = part;
    accumulated = accumulated ? `${accumulated}/${part}` : part;
    const target = accumulated;
    button.addEventListener('click', () => loadFiles(target));
    container.append(separator, button);
    if (index === parts.length - 1) button.classList.add('current');
  });
}
async function openFile(entry) {
  selectedFile = entry.path;
  try {
    const data = await api(`/api/files/content?path=${encodeURIComponent(entry.path)}`);
    const editor = $('#file-editor');
    editor.replaceChildren();
    const top = document.createElement('div'); top.className = 'editor-toolbar';
    const filename = document.createElement('strong'); filename.textContent = entry.name;
    const pathLabel = document.createElement('span'); pathLabel.textContent = entry.path;
    top.append(filename, pathLabel);
    const textarea = document.createElement('textarea'); textarea.className = 'code-editor'; textarea.spellcheck = false; textarea.value = data.content; textarea.setAttribute('aria-label', `Contenuto di ${entry.name}`); textarea.readOnly = me.role !== 'admin';
    editor.append(top, textarea);
    if (me.role === 'admin') {
      const actions = document.createElement('div'); actions.className = 'editor-actions';
      const status = document.createElement('span'); status.className = 'editor-status'; status.textContent = 'Salvataggio riservato agli admin';
      const save = document.createElement('button'); save.className = 'button button-primary'; save.textContent = 'Salva modifiche';
      save.addEventListener('click', async () => {
        try { await api('/api/files/content', { method: 'PUT', body: JSON.stringify({ path: entry.path, content: textarea.value }) }); status.textContent = 'Modifiche salvate'; notify('File salvato'); }
        catch (error) { status.textContent = error.message; notify(error.message, true); }
      });
      actions.append(status, save); editor.append(actions);
    }
    document.querySelectorAll('.file-entry').forEach(row => row.classList.toggle('selected', row.querySelector('.file-entry-name')?.textContent === entry.name));
  } catch (error) { notify(error.message, true); }
}
async function deleteFile(entry) {
  if (!window.confirm(`Eliminare ${entry.name}? L’operazione non può essere annullata.`)) return;
  try { await api('/api/files', { method: 'DELETE', body: JSON.stringify({ path: entry.path }) }); if (selectedFile === entry.path) { selectedFile = null; $('#file-editor').innerHTML = '<div class="editor-empty"><span>▤</span><strong>Seleziona un file di testo</strong><small>Le modifiche sono riservate agli admin</small></div>'; } await loadFiles(currentPath); notify('Elemento eliminato'); }
  catch (error) { notify(error.message, true); }
}
async function loadPlugins() {
  try {
    const data = await api('/api/files?path=plugins');
    const container = $('#plugin-list');
    const jars = data.entries.filter(entry => !entry.directory && entry.name.toLowerCase().endsWith('.jar'));
    if (!jars.length) { container.innerHTML = '<p class="muted">Nessun plugin installato.</p>'; return; }
    container.replaceChildren();
    jars.forEach(plugin => {
      const row = document.createElement('div'); row.className = 'plugin-row';
      const icon = document.createElement('span'); icon.className = 'plugin-icon'; icon.textContent = '⬡';
      const info = document.createElement('span'); info.className = 'plugin-info';
      const name = document.createElement('strong'); name.textContent = plugin.name;
      const size = document.createElement('small'); size.textContent = `${formatSize(plugin.size)} · aggiunto ${new Date(plugin.modifiedAt).toLocaleDateString('it-IT')}`;
      info.append(name, size);
      const tag = document.createElement('span'); tag.className = 'plugin-tag'; tag.textContent = 'JAR';
      row.append(icon, info, tag);
      if (me.role === 'admin') {
        const remove = document.createElement('button'); remove.className = 'file-delete'; remove.title = `Elimina ${plugin.name}`; remove.textContent = '×';
        remove.addEventListener('click', () => deleteFile(plugin)); row.append(remove);
      }
      container.append(row);
    });
  } catch { $('#plugin-list').innerHTML = '<p class="muted">La cartella plugins/ verrà creata al primo upload.</p>'; }
}
async function loadUsers() {
  try {
    const { users } = await api('/api/users');
    const list = $('#users-list'); list.replaceChildren();
    users.forEach(user => {
      const row = document.createElement('div'); row.className = 'user-row';
      const identity = document.createElement('div'); identity.className = 'user-identity';
      const avatar = document.createElement('span'); avatar.className = 'user-avatar'; avatar.textContent = user.username.charAt(0).toUpperCase();
      const name = document.createElement('strong'); name.textContent = user.username; identity.append(avatar, name);
      const role = document.createElement('span'); role.className = `user-role ${user.role}`; role.textContent = user.role === 'admin' ? 'ADMIN' : 'UTENTE';
      const permissions = document.createElement('label'); permissions.className = 'switch-label';
      if (user.role === 'admin') { const admin = document.createElement('span'); admin.className = 'fixed-access'; admin.textContent = 'Sempre attiva'; permissions.append(admin); }
      else {
        const toggle = document.createElement('input'); toggle.type = 'checkbox'; toggle.checked = user.consoleAccess; toggle.setAttribute('aria-label', `Accesso console per ${user.username}`);
        toggle.addEventListener('change', async () => { try { await api(`/api/users/${user.id}/console`, { method: 'PATCH', body: JSON.stringify({ allowed: toggle.checked }) }); notify(toggle.checked ? `Console concessa a ${user.username}` : `Console revocata a ${user.username}`); } catch (error) { toggle.checked = !toggle.checked; notify(error.message, true); } });
        const track = document.createElement('span'); track.className = 'switch-track'; permissions.append(toggle, track);
      }
      row.append(identity, role, permissions); list.append(row);
    });
  } catch (error) { notify(error.message, true); }
}
function escapeHtml(text) { const element = document.createElement('span'); element.textContent = text; return element.innerHTML; }

$('#auth-form').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('#auth-submit');
  $('#auth-error').textContent = '';
  setButtonBusy(button, true, 'Attendi...');
  const body = { username: form.elements.username.value, password: form.elements.password.value };
  try {
    const data = await api(form.dataset.setup === 'true' ? '/api/register' : '/api/login', { method: 'POST', body: JSON.stringify(body) });
    if (form.dataset.setup === 'true') { const check = await api('/api/bootstrap'); if (!check.setupRequired) { /* registration completed */ } }
    showApp(data.user);
  } catch (error) { $('#auth-error').textContent = error.message; }
  finally { setButtonBusy(button, false); }
});
$('#logout-button').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); if (socket) socket.disconnect(); consoleJoined = false; const { setupRequired, adminCreationEnabled } = await api('/api/bootstrap'); showAuth(setupRequired, adminCreationEnabled); });
document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => openView(button.dataset.view)));
document.querySelectorAll('[data-open]').forEach(button => button.addEventListener('click', () => openView(button.dataset.open)));
$('#start-button').addEventListener('click', async () => { const button = $('#start-button'); setButtonBusy(button, true, 'Avvio...'); try { await api('/api/server/start', { method: 'POST' }); notify('Avvio del server richiesto'); } catch (error) { notify(error.message, true); } finally { setButtonBusy(button, false); } });
$('#stop-button').addEventListener('click', async () => { if (!window.confirm('Arrestare il server in modo controllato?')) return; try { await api('/api/server/stop', { method: 'POST' }); notify('Arresto richiesto'); } catch (error) { notify(error.message, true); } });
$('#restart-button').addEventListener('click', async () => { if (!window.confirm('Salvare il mondo e riavviare il server?')) return; try { await api('/api/server/restart', { method: 'POST' }); notify('Riavvio controllato richiesto'); } catch (error) { notify(error.message, true); } });
$('#heap-max').addEventListener('input', () => updateMemoryMeter(Number($('#heap-max').max)));
$('#save-heap').addEventListener('click', async () => { try { await api('/api/settings', { method: 'PUT', body: JSON.stringify({ minHeapMb: Number($('#heap-min').value), maxHeapMb: Number($('#heap-max').value) }) }); notify('Impostazioni memoria salvate'); } catch (error) { notify(error.message, true); } });
$('#console-form').addEventListener('submit', event => { event.preventDefault(); const input = $('#command-input'); const command = input.value.trim(); if (!command || !socket) return; socket.emit('console:command', command); input.value = ''; });
$('#clear-console').addEventListener('click', () => $('#console-output').replaceChildren());
$('#refresh-players').addEventListener('click', async () => { try { await api('/api/server/players/refresh', { method: 'POST' }); notify('Richiesta lista giocatori inviata'); } catch (error) { notify(error.message, true); } });
$('#copy-server-address').addEventListener('click', async () => {
  const address = $('#detail-addresses').textContent.split(',')[0].replace(' (solo locale)', '').trim();
  try { await navigator.clipboard.writeText(address); notify(`Indirizzo copiato: ${address}`); }
  catch { notify('Impossibile accedere agli appunti', true); }
});
$('#create-backup').addEventListener('click', createBackup);
$('#save-backup-schedule').addEventListener('click', async () => {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify({ minHeapMb: Number($('#heap-min').value), maxHeapMb: Number($('#heap-max').value), backupIntervalHours: Number($('#backup-interval').value) }) });
    notify($('#backup-interval').value === '0' ? 'Backup automatico disattivato' : `Backup automatico ogni ${$('#backup-interval').value} ore`);
  } catch (error) { notify(error.message, true); }
});
$('#software-type').addEventListener('change', () => { $('#software-kind').textContent = $('#software-type').value === 'velocity' ? 'VELOCITY PROXY' : 'SERVER MINECRAFT'; $('#velocity-requirement').hidden = $('#software-type').value !== 'velocity'; });
$('#save-jar').addEventListener('click', async () => { try { await api('/api/server/jar', { method: 'PUT', body: JSON.stringify({ jar: $('#jar-select').value, serverType: $('#software-type').value }) }); notify('Software aggiornato'); await loadSoftware(); await loadServer(); } catch (error) { notify(error.message, true); } });
$('#create-server-button').addEventListener('click', async () => {
  $('#server-create-error').textContent = '';
  $('#server-create-form').reset();
  if (!$('#server-create-hostname')) {
    const hostnameLabel = document.createElement('label');
    hostnameLabel.textContent = 'Dominio personalizzato (opzionale)';
    const hostnameInput = document.createElement('input');
    hostnameInput.id = 'server-create-hostname';
    hostnameInput.maxLength = 253;
    hostnameInput.placeholder = 'play.esempio.it';
    hostnameInput.autocomplete = 'off';
    const hostnameHint = document.createElement('small');
    hostnameHint.textContent = 'Solo hostname. DNS e port forwarding si configurano separatamente.';
    hostnameLabel.append(hostnameInput, hostnameHint);
    $('#server-create-java').closest('label').after(hostnameLabel);
  }
  $('#server-create-software').value = 'paper';
  updateCreationSoftwareFields('paper');
  $('#server-create-dialog').showModal();
  $('#server-create-name').focus();
  await loadCreationOptions('paper');
});
$('#server-create-software').addEventListener('change', event => {
  updateCreationSoftwareFields(event.currentTarget.value);
  loadCreationOptions(event.currentTarget.value);
});
$('#server-create-form').addEventListener('submit', event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  createServer();
});
$('#server-address-form').addEventListener('submit', async event => {
  event.preventDefault();
  $('#server-address-error').textContent = '';
  const button = event.currentTarget.querySelector('button[type="submit"]');
  setButtonBusy(button, true, 'Salvataggio...');
  try {
    const result = await api('/api/server/address', { method: 'PUT', body: JSON.stringify({ hostname: $('#server-hostname').value.trim() }) });
    await loadServerDetails();
    notify(result.serverHostname ? `Indirizzo salvato: ${result.address}. Configura il DNS per renderlo raggiungibile.` : `Dominio rimosso. Indirizzo LAN: ${result.address}`);
  } catch (error) { $('#server-address-error').textContent = error.message; }
  finally { setButtonBusy(button, false); }
});
$('#server-jar-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('#server-jar-file').files[0];
  if (!file) return;
  const formData = new FormData(); formData.append('serverJar', file);
  const button = event.currentTarget.querySelector('button[type="submit"]'); setButtonBusy(button, true, 'Caricamento JAR...');
  $('#server-jar-message').textContent = '';
  try { const result = await api('/api/server/jars/upload', { method: 'POST', body: formData }); $('#server-jar-message').textContent = `${result.name} caricato. Selezionalo come JAR attivo.`; event.currentTarget.reset(); await loadSoftware(); await loadServer(); await loadServerDetails(); }
  catch (error) { $('#server-jar-message').textContent = error.message; notify(error.message, true); }
  finally { setButtonBusy(button, false); }
});
$('#refresh-files').addEventListener('click', () => loadFiles(currentPath));
$('#new-file-button').addEventListener('click', () => { $('#new-name').value = ''; $('#new-is-directory').checked = false; $('#create-dialog').showModal(); $('#new-name').focus(); });
$('#create-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  const name = $('#new-name').value.trim();
  if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..') { notify('Inserisci un nome file valido', true); return; }
  const location = currentPath === '.' ? name : `${currentPath}/${name}`;
  try { await api('/api/files', { method: 'POST', body: JSON.stringify({ path: location, directory: $('#new-is-directory').checked }) }); $('#create-dialog').close(); await loadFiles(currentPath); notify('Elemento creato'); }
  catch (error) { notify(error.message, true); }
});
$('#add-user-button').addEventListener('click', () => { $('#user-error').textContent = ''; $('#user-form').reset(); $('#user-dialog').showModal(); $('#new-username').focus(); });
$('#user-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  $('#user-error').textContent = '';
  const button = $('#user-confirm');
  setButtonBusy(button, true, 'Creazione...');
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ username: $('#new-username').value, password: $('#new-password').value }) });
    $('#user-dialog').close();
    await loadUsers();
    notify('Account creato. Comunica la password privatamente.');
  } catch (error) { $('#user-error').textContent = error.message; }
  finally { setButtonBusy(button, false); }
});
$('#add-admin-button').addEventListener('click', () => { $('#admin-error').textContent = ''; $('#admin-form').reset(); $('#admin-dialog').showModal(); $('#new-admin-username').focus(); });
$('#admin-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  $('#admin-error').textContent = '';
  const button = $('#admin-confirm');
  setButtonBusy(button, true, 'Verifica...');
  try {
    await api('/api/admins', { method: 'POST', body: JSON.stringify({
      username: $('#new-admin-username').value,
      password: $('#new-admin-password').value,
      currentPassword: $('#confirm-admin-password').value,
      code: $('#admin-creation-code').value
    }) });
    $('#admin-dialog').close();
    await loadUsers();
    notify('Account admin creato. Comunica le credenziali privatamente.');
  } catch (error) { $('#admin-error').textContent = error.message; }
  finally { setButtonBusy(button, false); }
});
$('#admin-create-open').addEventListener('click', () => { $('#admin-register-error').textContent = ''; $('#admin-register-form').reset(); $('#admin-register-dialog').showModal(); $('#admin-register-username').focus(); });
$('#admin-register-form').addEventListener('submit', async event => {
  if (event.submitter?.value === 'cancel') return;
  event.preventDefault();
  $('#admin-register-error').textContent = '';
  const button = $('#admin-register-submit');
  setButtonBusy(button, true, 'Verifica codice...');
  try {
    const username = $('#admin-register-username').value;
    await api('/api/admins/register', { method: 'POST', body: JSON.stringify({ username, password: $('#admin-register-password').value, code: $('#admin-register-code').value }) });
    $('#admin-register-dialog').close();
    $('#admin-register-form').reset();
    showAuth(false, true);
    authForm.elements.username.value = username;
    authForm.elements.password.focus();
    notify('Account admin creato. Accedi con la password appena impostata.');
  } catch (error) { $('#admin-register-error').textContent = error.message; }
  finally { setButtonBusy(button, false); }
});
$('#plugin-form').addEventListener('submit', async event => {
  event.preventDefault();
  const file = $('#plugin-file').files[0];
  if (!file) return;
  const formData = new FormData(); formData.append('plugin', file);
  const button = event.currentTarget.querySelector('button[type="submit"]'); setButtonBusy(button, true, 'Caricamento...');
  try { const result = await api('/api/plugins/upload', { method: 'POST', body: formData }); $('#plugin-message').textContent = `${result.name} caricato${result.restartRequired ? ' · riavvio necessario per attivare' : ''}`; event.currentTarget.reset(); await loadPlugins(); notify('Plugin caricato'); }
  catch (error) { $('#plugin-message').textContent = error.message; notify(error.message, true); }
  finally { setButtonBusy(button, false); }
});
const uploadZone = $('.upload-zone');
if (uploadZone) {
  uploadZone.addEventListener('dragover', event => { event.preventDefault(); uploadZone.classList.add('dragging'); });
  uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('dragging'));
  uploadZone.addEventListener('drop', event => { event.preventDefault(); uploadZone.classList.remove('dragging'); const file = event.dataTransfer.files[0]; if (file && file.name.toLowerCase().endsWith('.jar')) { $('#plugin-file').files = event.dataTransfer.files; } else notify('Seleziona un file .jar', true); });
}
(async function initialize() {
  try {
    const data = await api('/api/bootstrap');
    if (data.user) showApp(data.user);
    else showAuth(data.setupRequired, data.adminCreationEnabled);
  } catch { showAuth(false, false); }
})();
