import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { SyncError } from './core.js';

export function sourceURL(value) {
  let url;
  try { url = new URL(value.replace(/^webdav:/i, 'http:').replace(/^webdavs:/i, 'https:')); }
  catch { throw new SyncError('INVALID_URL', 'Configuration address must be an absolute URL'); }
  if (!['http:', 'https:', 'ssh:', 'file:'].includes(url.protocol)) throw new SyncError('INVALID_URL', 'Supported schemes: http, https, webdav, webdavs, ssh, file');
  if (url.password || (url.username && url.protocol !== 'ssh:') || url.hash) throw new SyncError('INVALID_URL', 'Keep passwords out of URLs; use a credential reference');
  return url;
}

export function sshArguments(url, timeoutSeconds, shell = 'posix') {
  const host = url.hostname;
  const user = decodeURIComponent(url.username);
  const file = decodeURIComponent(url.pathname);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(host) || (user && !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(user)) || url.search || !file.startsWith('/') || /[\x00-\x1f\x7f]/.test(file)) {
    throw new SyncError('INVALID_SSH_URL', 'SSH needs a host or SSH alias and an absolute path without control characters');
  }
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  let command = `cat -- ${quote(file)}`;
  if (shell === 'powershell') {
    const winPath = file.replace(/^\/([A-Za-z]:\/)/, '$1').replaceAll('/', '\\').replaceAll("'", "''");
    const script = `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); [Console]::Out.Write([IO.File]::ReadAllText('${winPath}', [Text.Encoding]::UTF8))`;
    command = 'powershell -NoProfile -NonInteractive -EncodedCommand ' + Buffer.from(script, 'utf16le').toString('base64');
  }
  return ['-T', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', `-oConnectTimeout=${Math.ceil(timeoutSeconds)}`,
    ...(url.port ? ['-p', url.port] : []), '--', user ? `${user}@${host}` : host, command];
}

function sshRead(url, options, signal, spawnProcess) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0; let settled = false;
    const child = spawnProcess('ssh', sshArguments(url, options.timeoutSeconds, options.sshShell), { windowsHide: true, shell: false, stdio: ['ignore','pipe','pipe'], signal });
    const fail = error => { if (!settled) { settled = true; child.kill(); reject(error); } };
    child.stdout.on('data', bytes => {
      size += bytes.length;
      if (size > options.maxBytes) fail(new SyncError('TOO_LARGE', 'Remote configuration exceeds the byte limit'));
      else parts.push(bytes);
    });
    child.stderr.resume(); // Never log remote output: it can contain credentials or arbitrary text.
    child.on('error', () => fail(new SyncError('SSH_FAILED', 'SSH failed; check OpenSSH, key authentication, and known_hosts')));
    child.on('close', code => {
      if (settled) return;
      settled = true;
      if (code !== 0) reject(new SyncError('SSH_FAILED', 'SSH could not read the file; check the path, permissions, and sshShell setting'));
      else resolve({ text: Buffer.concat(parts).toString('utf8') });
    });
  });
}

/** Bound both compressed-transfer output and read duration, including body consumption. */
export async function readSource(options, cached, headers = {}, parentSignal, deps = {}) {
  const url = sourceURL(options.url);
  const signal = AbortSignal.any([AbortSignal.timeout(options.timeoutSeconds * 1000), ...(parentSignal ? [parentSignal] : [])]);
  if (url.protocol === 'ssh:') return sshRead(url, options, signal, deps.spawn ?? spawn);
  if (url.protocol === 'file:') {
    try {
      const file = fileURLToPath(url);
      const stat = await fs.stat(file);
      if (!stat.isFile() || stat.size > options.maxBytes) throw new SyncError('TOO_LARGE', 'Configuration is not a regular file within the byte limit');
      const text = await fs.readFile(file, { encoding: 'utf8', signal });
      if (Buffer.byteLength(text) > options.maxBytes) throw new SyncError('TOO_LARGE', 'Remote configuration exceeds the byte limit');
      return { text };
    } catch (error) {
      if (error instanceof SyncError) throw error;
      throw new SyncError('FILE_FAILED', 'Cannot read the configuration file or network share');
    }
  }
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Accept', 'application/json');
  if (cached?.etag) requestHeaders.set('If-None-Match', cached.etag);
  if (cached?.lastModified) requestHeaders.set('If-Modified-Since', cached.lastModified);
  let current = url;
  try {
    for (let redirects = 0; redirects <= 5; redirects++) {
      const response = await (deps.fetch ?? fetch)(current, { headers: requestHeaders, redirect: 'manual', signal });
      if ([301,302,303,307,308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects === 5) throw new SyncError('REDIRECT', 'Invalid redirect or too many redirects');
        const next = sourceURL(new URL(location, current).href);
        if (!['http:', 'https:'].includes(next.protocol) || (current.protocol === 'https:' && next.protocol !== 'https:')) throw new SyncError('REDIRECT', 'Unsafe redirect refused');
        if (next.origin !== current.origin && Object.keys(headers).length) throw new SyncError('REDIRECT', 'Credentialed redirects to another origin are refused');
        current = next;
        continue;
      }
      if (response.status === 304 && cached?.text !== undefined) { await response.body?.cancel(); return cached; }
      if (!response.ok) { await response.body?.cancel(); throw new SyncError('HTTP_FAILED', `Configuration server returned HTTP ${response.status}`); }
      if (Number(response.headers.get('content-length')) > options.maxBytes) { await response.body?.cancel(); throw new SyncError('TOO_LARGE', 'Remote configuration exceeds the byte limit'); }
      const chunks = []; let size = 0;
      if (!response.body) throw new SyncError('EMPTY_DOCUMENT', 'Configuration response has no body');
      for await (const bytes of response.body) {
        size += bytes.length;
        if (size > options.maxBytes) throw new SyncError('TOO_LARGE', 'Remote configuration exceeds the byte limit');
        chunks.push(bytes);
      }
      return { text: Buffer.concat(chunks).toString('utf8'), etag: response.headers.get('etag'), lastModified: response.headers.get('last-modified') };
    }
  } catch (error) {
    if (error instanceof SyncError) throw error;
    throw new SyncError(signal.aborted ? 'TIMEOUT' : 'NETWORK_FAILED', signal.aborted ? 'Configuration fetch timed out or was cancelled' : 'Cannot reach the configuration server');
  }
}
