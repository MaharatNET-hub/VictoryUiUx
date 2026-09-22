'use strict';
/* خادم تجربة الماسح — Node قياسي بلا أي تبعيات خارجية.
   يستقبل المسح، يُنقص المخزون، ويبثّه لحظياً لكل الشاشات المفتوحة. */

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const GUARD_MS = 700;          // نافذة منع الخصم المزدوج
const HEARTBEAT_HITS = 5;      // تكرار رمز غير مرتبط => نبض جهاز
const HEARTBEAT_WINDOW = 15000;

const CATALOG = [
  { id:1, name:'زيت زيتون بكر فاخر ١ل', img:'assets/clean/cat-oil.png',    stock:420 },
  { id:2, name:'أرز بسمتي ٥ كغ',        img:'assets/clean/cat-rice.png',   stock:180 },
  { id:3, name:'مناديل ورقية ×٦',       img:'assets/clean/cat-clean.png',  stock:900 },
  { id:4, name:'تونة معلبة ×٤',         img:'assets/clean/cat-canned.png', stock:260 },
  { id:5, name:'مسحوق غسيل ٣ كغ',       img:'assets/clean/cat-clean.png',  stock:340 },
  { id:6, name:'شاي أسود ١٠٠ ظرف',      img:'assets/clean/cat-spices.png', stock:510 },
  { id:7, name:'عصير برتقال ١ل ×٦',     img:'assets/clean/cat-drinks.png', stock:150 },
  { id:8, name:'سكر أبيض ١٠ كغ',        img:'assets/clean/cat-food.png',   stock:220 }
];

const bootedAt = new Date().toISOString();
let S;
const reset = () => { S = {
  stock: Object.fromEntries(CATALOG.map(p => [p.id, p.stock])),
  links: {}, muted: [], log: [], seq: 0, seen: Object.create(null)
}; };
reset();

/* ───────── البث اللحظي ───────── */
const clients = new Set();
function broadcast(event, data){
  const frame = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of clients) { try { res.write(frame); } catch (e) { clients.delete(res); } }
}
setInterval(() => { for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) {} } }, 25000);

/* ───────── منطق المسح ───────── */
function registerScan(code, source){
  code = String(code || '').trim();
  if (!code) return { ok:false, reason:'empty' };
  if (S.muted.indexOf(code) !== -1) return { ok:false, reason:'muted', code };

  const now = Date.now();

  // كشف نبض الجهاز: رمز غير مرتبط يتكرر بوتيرة رتيبة
  const r = S.seen[code] || (S.seen[code] = { n:0, first:now, last:0 });
  if (now - r.first > HEARTBEAT_WINDOW) { r.n = 0; r.first = now; }
  r.n++;
  if (r.n >= HEARTBEAT_HITS && !S.links[code]) {
    S.muted.push(code);
    broadcast('muted', { code, at:new Date().toISOString() });
    return { ok:false, reason:'heartbeat', code };
  }

  // منع الخصم المزدوج
  if (r.last && now - r.last < GUARD_MS) { r.last = now; return { ok:false, reason:'duplicate', code }; }
  r.last = now;

  S.seq++;
  const productId = S.links[code] || null;
  let stock = null, out = false;
  if (productId) {
    if (S.stock[productId] > 0) S.stock[productId]--; else out = true;
    stock = S.stock[productId];
  }

  const rec = {
    seq: S.seq, code, productId, stock, out,
    known: !!productId,
    at: new Date().toISOString(),
    source: source || 'unknown'
  };
  S.log.unshift(rec);
  if (S.log.length > 60) S.log.pop();
  broadcast('scan', rec);
  return { ok:true, record: rec };
}

/* ───────── أدوات HTTP ───────── */
const MIME = { '.html':'text/html; charset=utf-8', '.js':'text/javascript; charset=utf-8',
  '.css':'text/css; charset=utf-8', '.json':'application/json; charset=utf-8', '.png':'image/png',
  '.jpg':'image/jpeg', '.jpeg':'image/jpeg', '.svg':'image/svg+xml', '.ico':'image/x-icon',
  '.webp':'image/webp', '.jsx':'text/plain; charset=utf-8' };

const json = (res, code, body) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type':'application/json; charset=utf-8',
                        'Cache-Control':'no-store', 'Content-Length':Buffer.byteLength(s) });
  res.end(s);
};

function readBody(req){
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', c => { n += c.length; if (n > 64 * 1024) { reject(new Error('too large')); req.destroy(); } parts.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(parts).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

const snapshot = () => ({
  catalog: CATALOG, stock: S.stock, links: S.links, muted: S.muted,
  log: S.log.slice(0, 20), seq: S.seq, serverTime: new Date().toISOString(), bootedAt
});

/* ───────── الخادم ───────── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  const p = u.pathname;

  if (p.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');

  // الحالة الراهنة
  if (p === '/api/state' && req.method === 'GET') return json(res, 200, snapshot());

  // بثّ لحظي للشاشات الأخرى
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type':'text/event-stream; charset=utf-8',
      'Cache-Control':'no-cache, no-transform', 'Connection':'keep-alive', 'X-Accel-Buffering':'no' });
    res.write('retry: 3000\n\n');
    res.write('event: hello\ndata: ' + JSON.stringify(snapshot()) + '\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  if (req.method === 'POST' && p === '/api/scan') {
    let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { ok:false, reason:'bad json' }); }
    const out = registerScan(b.code, b.source);
    return json(res, 200, Object.assign({ serverTime:new Date().toISOString() }, out));
  }

  if (req.method === 'POST' && p === '/api/bind') {
    let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { ok:false }); }
    const code = String(b.code || '').trim(), pid = Number(b.productId);
    if (!code || !CATALOG.some(x => x.id === pid)) return json(res, 400, { ok:false, reason:'bad input' });
    for (const c of Object.keys(S.links)) if (S.links[c] === pid) delete S.links[c];
    S.links[code] = pid;
    const i = S.muted.indexOf(code); if (i !== -1) S.muted.splice(i, 1);
    if (S.seen[code]) { S.seen[code].n = 0; S.seen[code].last = 0; }
    broadcast('bind', { code, productId:pid });
    return json(res, 200, { ok:true, links:S.links });
  }

  if (req.method === 'POST' && p === '/api/mute') {
    let b; try { b = await readBody(req); } catch (e) { return json(res, 400, { ok:false }); }
    const code = String(b.code || '').trim();
    if (code && S.muted.indexOf(code) === -1) S.muted.push(code);
    broadcast('muted', { code, at:new Date().toISOString() });
    return json(res, 200, { ok:true, muted:S.muted });
  }

  if (req.method === 'POST' && p === '/api/reset') {
    reset(); broadcast('reset', snapshot());
    return json(res, 200, { ok:true });
  }

  // ملفات الموقع الثابتة
  if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { ok:false });
  let rel = decodeURIComponent(p === '/' ? '/index.html' : p).replace(/^\/+/, '');
  const file = path.resolve(ROOT, rel);
  if (!file.startsWith(ROOT + path.sep) && file !== ROOT) { res.writeHead(403); return res.end('forbidden'); }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' }); return res.end('غير موجود'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
                         'Content-Length': st.size });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
});

/* نطبع عناوين الشبكة المحلية كي يفتح هاتف العميل الصفحة من الجهاز نفسه */
function lanAddresses(){
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const ni of nets[name] || []) {
      if (ni.family === 'IPv4' && !ni.internal) out.push(ni.address);
    }
  }
  return out;
}

server.listen(PORT, () => {
  const lan = lanAddresses();
  console.log('');
  console.log('  خادم تجربة الماسح يعمل الآن.');
  console.log('');
  console.log('  على هذا الجهاز:   http://localhost:' + PORT + '/scan.html');
  if (lan.length) {
    console.log('');
    console.log('  على هاتف العميل (نفس شبكة الواي فاي):');
    for (const ip of lan) console.log('     http://' + ip + ':' + PORT + '/scan.html');
  } else {
    console.log('');
    console.log('  تعذّر إيجاد عنوان شبكة محلي — تأكد من اتصال الجهاز بالواي فاي.');
  }
  console.log('');
  console.log('  لإيقاف الخادم: أغلق هذه النافذة أو اضغط Ctrl + C');
  console.log('');
});
