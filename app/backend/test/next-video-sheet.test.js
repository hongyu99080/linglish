// app/backend/test/next-video-sheet.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const NextVideoSheet = require('../../frontend/js/video-reader/next-video-sheet');
const Client = require('../../frontend/js/video-recommendation-client');

function fakeDoc() {
  const nodes = {};
  const makeEl = () => {
    const el = {
      hidden: false,
      className: '',
      textContent: '',
      listeners: {},
      classList: { add() {}, remove() {} },
      setAttribute() {},
      addEventListener(type, fn) { this.listeners[type] = fn; },
      querySelector(sel) {
        const role = /data-role="([^"]+)"/.exec(sel)[1];
        nodes[role] = nodes[role] || makeEl();
        return nodes[role];
      },
      appendChild() {},
    };
    return el;
  };
  const body = makeEl();
  let appended = null;
  body.appendChild = (el) => { appended = el; };
  return {
    nodes,
    get sheet() { return appended; },
    body,
    head: { appendChild() {} },
    getElementById() { return null; },
    createElement: makeEl,
  };
}

function clientReturning(video) {
  return { ...Client, fetchNextVideo: async () => video };
}

test('formatMinutes: 秒数转分钟,空值返回空串', () => {
  assert.equal(NextVideoSheet.formatMinutes(0), '');
  assert.equal(NextVideoSheet.formatMinutes(20), '1 分钟');
  assert.equal(NextVideoSheet.formatMinutes(300), '5 分钟');
});

test('showAfter: 接口无结果时不渲染、不上报', async () => {
  const doc = fakeDoc();
  const events = [];
  const sheet = NextVideoSheet.create({
    doc, client: clientReturning(null), getToken: () => null,
    postEvent: (n) => events.push(n), onOpen() {},
  });
  assert.equal(await sheet.showAfter(1), null);
  assert.equal(doc.sheet, null);
  assert.deepEqual(events, []);
});

test('showAfter: 渲染推荐理由并上报一次曝光,点击后上报 click 并打开', async () => {
  const doc = fakeDoc();
  const events = [];
  const opened = [];
  const video = { id: 9, title: 'Next talk', recommendationReason: '和你刚看的都是「职场」', levelName: '初级', duration: 240 };
  const sheet = NextVideoSheet.create({
    doc, client: clientReturning(video), getToken: () => 't',
    postEvent: (n, p) => events.push({ n, p }), onOpen: (v) => opened.push(v.id),
  });
  await sheet.showAfter(1);
  await sheet.showAfter(1);
  assert.equal(doc.sheet.hidden, false);
  assert.equal(doc.nodes.reason.textContent, '和你刚看的都是「职场」');
  assert.equal(doc.nodes.meta.textContent, '初级 · 4 分钟');
  assert.equal(events.filter(e => e.n === 'reco_impression').length, 1);

  doc.nodes.go.listeners.click();
  assert.deepEqual(opened, [9]);
  assert.equal(events.at(-1).n, 'reco_click');
  assert.equal(events.at(-1).p.slot, 'next');
  assert.equal(doc.sheet.hidden, true);
});

test('hide: 切换视频后迟到的推荐结果不再弹出', async () => {
  const doc = fakeDoc();
  let resolve;
  const client = { ...Client, fetchNextVideo: () => new Promise(r => { resolve = r; }) };
  const sheet = NextVideoSheet.create({ doc, client, getToken: () => null, postEvent() {}, onOpen() {} });
  const pending = sheet.showAfter(1);
  sheet.hide();
  resolve({ id: 2, title: 'Late' });
  assert.equal(await pending, null);
  assert.equal(doc.sheet, null);
});
