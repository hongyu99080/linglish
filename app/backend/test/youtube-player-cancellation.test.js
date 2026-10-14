const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const playerPath = path.resolve(__dirname, '../../frontend/js/app/youtube-player.js');

test('destroy cancels initialization while the YouTube API is loading', async () => {
  let createdPlayers = 0;
  try {
    global.window = {
      location: { origin: 'https://www.example.com', protocol: 'https:', host: 'www.example.com' },
    };
    global.document = {
      createElement: () => ({ parentNode: null }),
      getElementsByTagName: () => [],
      head: { appendChild: () => {} },
      getElementById: () => ({ innerHTML: '' }),
    };

    delete require.cache[playerPath];
    const YouTubePlayer = require(playerPath);
    const player = new YouTubePlayer('youtube-player');
    const pending = player.init('old-video');

    player.destroy();
    global.window.YT = {
      Player: function Player() { createdPlayers += 1; },
      PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 },
    };
    global.YT = global.window.YT;
    global.window.onYouTubeIframeAPIReady();

    const outcome = await Promise.race([
      pending.then(() => 'resolved', error => error && error.code),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 300)),
    ]);

    assert.equal(outcome, 'YOUTUBE_INIT_CANCELLED');
    assert.equal(createdPlayers, 0);
  } finally {
    delete require.cache[playerPath];
    delete global.window;
    delete global.YT;
    delete global.document;
  }
});

test('destroy tears down a YouTube player that was created but is not ready', async () => {
  let createdPlayers = 0;
  let destroyedPlayers = 0;
  let signalCreated;
  const created = new Promise(resolve => { signalCreated = resolve; });
  try {
    global.window = {
      location: { origin: 'https://www.example.com', protocol: 'https:', host: 'www.example.com' },
      YT: {
        Player: function Player() {
          createdPlayers += 1;
          this.getPlayerState = () => undefined;
          this.destroy = () => { destroyedPlayers += 1; };
          signalCreated();
        },
        PlayerState: { PLAYING: 1, PAUSED: 2, ENDED: 0 },
      },
    };
    global.YT = global.window.YT;
    global.document = {
      getElementById: () => ({ innerHTML: '' }),
    };

    delete require.cache[playerPath];
    const YouTubePlayer = require(playerPath);
    const player = new YouTubePlayer('youtube-player');
    const pending = player.init('old-video');

    await created;
    player.destroy();
    const outcome = await Promise.race([
      pending.then(() => 'resolved', error => error && error.code),
      new Promise(resolve => setTimeout(() => resolve('timeout'), 300)),
    ]);

    assert.equal(outcome, 'YOUTUBE_INIT_CANCELLED');
    assert.equal(createdPlayers, 1);
    assert.equal(destroyedPlayers, 1);
  } finally {
    delete require.cache[playerPath];
    delete global.window;
    delete global.YT;
    delete global.document;
  }
});
