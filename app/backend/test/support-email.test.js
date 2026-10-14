const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function configuredEmail(value) {
  const previous = process.env.SUPPORT_EMAIL;
  try {
    if (value === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = value;
    return require('../utils/support-email').getSupportEmail();
  } finally {
    if (previous === undefined) delete process.env.SUPPORT_EMAIL;
    else process.env.SUPPORT_EMAIL = previous;
  }
}

test('support email uses a public default and accepts a plain configured address', () => {
  assert.equal(configuredEmail(undefined), 'hello@example.com');
  assert.equal(configuredEmail(' team+help@example.test '), 'team+help@example.test');
});

test('support email rejects markup, header injection, and malformed addresses', () => {
  for (const value of ['help@example.test\" onclick=\"alert(1)', 'help@example.test\nBcc:person@example.test', 'team@example.test/path', 'name', 'a..b@example.test', 'team@-example.test']) {
    assert.throws(() => configuredEmail(value), /SUPPORT_EMAIL/);
  }
});

test('public contact links, text, SEO contact data, and HEAD lengths use the deployment address', () => {
  const script = `
const http = require('node:http');
const assert = require('node:assert/strict');
const base = process.argv[1];
const {registerStaticRoutes} = require(base+'/routes/static');
const {registerSeoRoutes} = require(base+'/routes/seo');
const server = http.createServer(async (req,res) => {
  try {
    const url = new URL(req.url,'http://localhost');
    if (await registerSeoRoutes(url.pathname,req,res,url)) return;
    if (await registerStaticRoutes(url.pathname,req,res,url)) return;
    res.writeHead(404);res.end();
  } catch (_) {res.writeHead(500);res.end();}
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const origin='http://127.0.0.1:'+server.address().port;
 for(const page of ['/','/pricing.html','/privacy.html','/terms.html']){
  const response=await fetch(origin+page);assert.equal(response.status,200);
  const body=await response.text();assert.ok(body.includes('mailto:team+help@example.test'));
  assert.ok(!body.includes('hello@example.com'));
  const head=await fetch(origin+page,{method:'HEAD'});assert.equal(head.status,200);
  assert.equal(Number(head.headers.get('content-length')),Buffer.byteLength(body));
  assert.equal((await head.arrayBuffer()).byteLength,0);
 }
 const guide=await (await fetch(origin+'/llms.txt')).text();
 assert.ok(guide.includes('Support: team+help@example.test'));
 const plugin=await (await fetch(origin+'/.well-known/ai-plugin.json')).json();
 assert.equal(plugin.contact_email,'team+help@example.test');
 await new Promise(resolve=>server.close(resolve));
 console.log('SUPPORT_CHECK_RESULT '+JSON.stringify({passed:true}));
 process.exit(0);
})().catch(error=>{console.error(error.message);process.exit(1);});
`;
  const result = spawnSync(process.execPath, ['-e', script, path.resolve(__dirname, '..')], {
    env: { ...process.env, DATABASE_URL: '', NODE_ENV: 'test', SITE_URL: 'https://public.example.test', SUPPORT_EMAIL: 'team+help@example.test' },
    encoding: 'utf8', timeout: 20000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /SUPPORT_CHECK_RESULT.*"passed":true/);
});
