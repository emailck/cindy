/** Runs in a disposable container with no account mounts. Credentials come only
 * from its environment; the destination is fixed and redirects are not followed.
 */
export const PROXY_PROBE = String.raw`
const http = require('node:http'), https = require('node:https'), tls = require('node:tls');
const proxy = new URL(process.env.HTTPS_PROXY);
const deadline = setTimeout(() => process.exit(2), 15000);
const fail = () => process.exit(2);
const headers = { host: 'ipwho.is:443' };
if (proxy.username) headers['proxy-authorization'] = 'Basic ' + Buffer.from(decodeURIComponent(proxy.username) + ':' + decodeURIComponent(proxy.password)).toString('base64');
const connect = http.request({ hostname: proxy.hostname.replace(/^\[|\]$/g, ''), port: proxy.port || 80,
  method: 'CONNECT', path: 'ipwho.is:443', headers, agent: false });
connect.on('error', fail);
connect.on('connect', (response, socket, head) => {
  if (response.statusCode !== 200) { socket.destroy(); fail(); return; }
  if (head.length) socket.unshift(head);
  const agent = new https.Agent();
  agent.createConnection = options => tls.connect({ ...options, socket, servername: 'ipwho.is' });
  const request = https.get({ hostname: 'ipwho.is', path: '/', agent }, response => {
    if (response.statusCode !== 200) { response.destroy(); fail(); return; }
    let body = '';
    response.on('error', fail);
    response.on('data', chunk => { body += chunk; if (body.length > 65536) fail(); });
    response.on('end', () => {
      try {
        const value = JSON.parse(body);
        if (value.success !== true) { fail(); return; }
        process.stdout.write(JSON.stringify({ ip: value.ip, country: value.country, region: value.region, city: value.city }));
        agent.destroy(); clearTimeout(deadline);
      } catch { fail(); }
    });
  });
  request.on('error', fail);
});
connect.end();
`;
