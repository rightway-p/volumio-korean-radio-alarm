'use strict';

const test = require('node:test');
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
  normalizeSelectValue,
  isValidTime,
  buildCronExpressions,
  stationOptionsFromCatalog,
  findStationByUri,
  STATION_URI_PREFIX,
  SOURCE_URI
} = require('../lib/alarm');

const KoreanRadioAlarm = require('..');

test('normalizeSelectValue accepts Volumio select objects', () => {
  assert.strictEqual(normalizeSelectValue({ value: '30', label: '30' }, 0, 59, 5, null), 30);
  assert.strictEqual(normalizeSelectValue({ value: 40 }, 0, 100, 10, null), 40);
  assert.strictEqual(normalizeSelectValue({ value: 'invalid' }, 0, 100, 1, null), null);
});

test('isValidTime accepts 00-23 hours and 5-minute increments', () => {
  assert.strictEqual(isValidTime(0, 0), true);
  assert.strictEqual(isValidTime(23, 55), true);
  assert.strictEqual(isValidTime(12, 25), true);
  assert.strictEqual(isValidTime(24, 0), false);
  assert.strictEqual(isValidTime(10, 60), false);
  assert.strictEqual(isValidTime(-1, 0), false);
});

test('buildCronExpressions maps weekdays to cron entries', () => {
  const expr = buildCronExpressions(7, 30, {
    monday: true,
    wednesday: true,
    friday: false,
    sunday: true
  });

  assert.deepStrictEqual(expr, [
    '0 30 7 * * 1',
    '0 30 7 * * 3',
    '0 30 7 * * 0'
  ]);
});

test('stationOptionsFromCatalog flattens catalog preserving group labels', () => {
  const options = stationOptionsFromCatalog({
    groups: [
      {
        id: 'kbs',
        name: 'KBS',
        stations: [
          { id: 'one', name: 'KBS One', streamUrl: 'https://example.com/one', uri: STATION_URI_PREFIX + 'one' },
          { id: 'two', name: 'KBS Two', streamUrl: 'https://example.com/two', uri: STATION_URI_PREFIX + 'two' }
        ]
      },
      {
        id: 'mbc',
        name: 'MBC',
        stations: [
          { id: 'three', name: 'MBC FM', streamUrl: 'https://example.com/three', uri: STATION_URI_PREFIX + 'three' }
        ]
      }
    ]
  });

  assert.deepStrictEqual(options, [
    { value: STATION_URI_PREFIX + 'one', label: 'KBS - KBS One' },
    { value: STATION_URI_PREFIX + 'two', label: 'KBS - KBS Two' },
    { value: STATION_URI_PREFIX + 'three', label: 'MBC - MBC FM' }
  ]);
});

test('radio station catalog removes unstable groups and adds KBS production-safe stations', () => {
  var catalog = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'radio_stations.json'), 'utf8'));
  var groupIds = catalog.groups.map(function (group) {
    return group.id;
  });

  assert.strictEqual(groupIds.includes('mbc'), false);
  assert.strictEqual(groupIds.includes('sbs'), false);

  var kbs = catalog.groups.find(function (group) {
    return group.id === 'kbs';
  });
  assert.strictEqual(Array.isArray(kbs.stations), true);

  var hanminjok = kbs.stations.find(function (station) {
    return station.id === 'kbs-hanminjok';
  });
  var world = kbs.stations.find(function (station) {
    return station.id === 'kbs-world-radio';
  });

  assert.strictEqual(hanminjok.name, 'KBS Hanminjok');
  assert.strictEqual(world.streamResolver.type, 'kbs-play-api');
  assert.strictEqual(world.streamResolver.channelId, 'worldradio');
});

function createPlugin(coreCommand) {
  var plugin = new KoreanRadioAlarm({
    coreCommand: coreCommand || {},
    logger: { info: function () {}, error: function () {} }
  });

  plugin.catalog = {
    groups: [
      {
        id: 'kbs',
        name: 'KBS',
        stations: [
          { id: 'classic', name: 'KBS Classic FM', streamUrl: 'https://example.com/stream' }
        ]
      }
    ]
  };

  return plugin;
}

test('browse source registration uses addToBrowseSources when available', () => {
  var addCalls = [];
  var plugin = createPlugin({
    addToBrowseSources: function (entry) {
      addCalls.push(entry);
    }
  });

  plugin._addBrowseSource();

  assert.strictEqual(addCalls.length, 1);
  assert.strictEqual(addCalls[0].uri, SOURCE_URI);
  assert.strictEqual(addCalls[0].source, 'korean_radio_alarm');
  assert.strictEqual(addCalls[0].sourceicon, 'fa-clock-o');
  assert.strictEqual(addCalls[0].albumart, '/albumart?source=korean_radio_alarm');
});

test('browse source registration falls back to volumioAddToBrowseSources', () => {
  var fallbackCalls = [];
  var plugin = createPlugin({
    volumioAddToBrowseSources: function (entry) {
      fallbackCalls.push(entry);
    }
  });

  plugin._addBrowseSource();

  assert.strictEqual(fallbackCalls.length, 1);
});

test('onStart succeeds when i18nJson requires UIConfig path and still registers browse source', async () => {
  var browseEntries = [];
  var plugin = createPlugin({
    addToBrowseSources: function (entry) {
      browseEntries.push(entry);
    },
    i18nJson: function (_requested, _fallback, uiConfigPath) {
      if (!uiConfigPath) {
        throw new TypeError('The "path" argument must be of type string or an instance of Buffer or URL. Received undefined');
      }
      return {};
    }
  });

  await plugin.onStart();

  assert.strictEqual(browseEntries.length, 1);
  assert.strictEqual(browseEntries[0].source, 'korean_radio_alarm');
});

test('remove browse source calls compatible command router remove method', () => {
  var removedUri;
  var plugin = createPlugin({
    removeBrowseSource: function (uri) {
      removedUri = uri;
    }
  });

  plugin._removeBrowseSource();

  assert.strictEqual(removedUri, SOURCE_URI);
});

test('handleBrowseUri and explodeUri stay consistent with station option URIs', async () => {
  var plugin = createPlugin({
    getLanguage: function () {
      return 'en';
    }
  });

  var option = stationOptionsFromCatalog(plugin.catalog)[0];
  var tracks = await plugin.explodeUri(option.value);
  var root = await plugin.handleBrowseUri(SOURCE_URI);
  var groupNavigation = await plugin.handleBrowseUri(SOURCE_URI + 'group/kbs');

  assert.strictEqual(Array.isArray(tracks), true);
  assert.strictEqual(tracks.length, 1);
  assert.strictEqual(tracks[0].uri, option.value);
  assert.strictEqual(root.navigation.prev.uri, SOURCE_URI);
  assert.strictEqual(groupNavigation.navigation.lists[0].items[0].uri, option.value);
  assert.strictEqual(groupNavigation.navigation.prev.uri, SOURCE_URI);
  assert.strictEqual(option.value, STATION_URI_PREFIX + 'classic');
});

test('explodeUri resolves dynamic streamResolver urls before playback', async () => {
  var plugin = createPlugin({
    getLanguage: function () {
      return 'en';
    }
  });
  plugin.catalog = {
    groups: [
      {
        id: 'kbs',
        name: 'KBS',
        stations: [
          {
            id: 'world-radio',
            name: 'KBS World Radio',
            streamResolver: {
              type: 'kbs-play-api',
              channelId: 'worldradio'
            }
          }
        ]
      }
    ]
  };
  plugin._ensureStationUris && plugin._ensureStationUris();
  plugin._requestJson = function (url, options) {
    assert.strictEqual(url, 'https://static.api.kbs.co.kr/play/1.2/live/channel/worldradio');
    assert.strictEqual(options.headers.Authorization.length > 0, true);
    return Promise.resolve({
      streamUrl: 'https://kbs-world.live/playlist.m3u8'
    });
  };

  var tracks = await plugin.explodeUri(STATION_URI_PREFIX + 'world-radio');
  assert.strictEqual(tracks[0].realUri, 'https://kbs-world.live/playlist.m3u8');
  assert.strictEqual(tracks[0].path, 'https://kbs-world.live/playlist.m3u8');
});

test('explodeUri rejects dynamic resolver payload without streamUrl', async () => {
  var plugin = createPlugin({
    getLanguage: function () {
      return 'en';
    }
  });
  plugin.catalog = {
    groups: [
      {
        id: 'kbs',
        name: 'KBS',
        stations: [
          {
            id: 'world-radio',
            name: 'KBS World Radio',
            streamResolver: {
              type: 'kbs-play-api',
              channelId: 'worldradio'
            }
          }
        ]
      }
    ]
  };
  plugin._ensureStationUris && plugin._ensureStationUris();
  plugin._requestJson = function () {
    return Promise.resolve({});
  };

  var captured;
  try {
    await plugin.explodeUri(STATION_URI_PREFIX + 'world-radio');
    assert.fail('expected resolver payload validation to reject');
  } catch (err) {
    captured = err;
  }

  assert.strictEqual(captured instanceof Error, true);
  assert.match(captured.message, /Invalid KBS play api response for station world-radio/);
});

test('findStationByUri resolves both direct ids and uri values', () => {
  const catalog = {
    groups: [
      {
        id: 'news',
        name: 'News',
        stations: [
          { id: 'ytn', name: 'YTN', streamUrl: 'https://example.com/ytn', uri: STATION_URI_PREFIX + 'ytn' }
        ]
      }
    ]
  };

  const byUri = findStationByUri(catalog, STATION_URI_PREFIX + 'ytn');
  const byUriObject = findStationByUri(catalog, { value: STATION_URI_PREFIX + 'ytn', label: 'YTN' });
  const byId = findStationByUri(catalog, 'ytn');
  const missing = findStationByUri(catalog, 'unknown');

  assert.strictEqual(byUri.name, 'YTN');
  assert.strictEqual(byUriObject.name, 'YTN');
  assert.strictEqual(byId.name, 'YTN');
  assert.strictEqual(missing, null);
});

test('clearAddPlayTrack passes plugin service and metadata to stateMachine.syncState', async () => {
  var plugin = createPlugin({
    addToBrowseSources: function () {},
    volumioSetVolume: function () {}
  });

  var mpdCalls = [];
  var syncStateCalls = [];

  plugin.mpdPlugin = {
    sendMpdCommand: function (command, args, cb) {
      mpdCalls.push([command, args]);
      if (typeof cb === 'function') {
        cb(null, true);
        return;
      }
      return Promise.resolve(true);
    },
    getState: function (cb) {
      var state = {
        status: 'playing',
        service: 'mpd',
        uri: 'https://old.example.com/stream',
        title: ''
      };
      if (typeof cb === 'function') {
        cb(null, state);
        return;
      }
      return Promise.resolve(state);
    }
  };

  plugin.commandRouter = {
    stateMachine: {
      syncState: function (state, service, cb) {
        syncStateCalls.push([state, service]);
        if (typeof cb === 'function') {
          cb(null, true);
          return;
        }
        return Promise.resolve(true);
      }
    }
  };

  await plugin.clearAddPlayTrack({
    service: 'korean_radio_alarm',
    uri: 'korean_radio_alarm://station/classic',
    realUri: 'https://radio.example.com/stream',
    name: 'KBS Classic FM'
  });

  assert.strictEqual(mpdCalls.length, 4);
  assert.strictEqual(syncStateCalls.length, 1);
  assert.strictEqual(syncStateCalls[0][1], 'korean_radio_alarm');
  assert.strictEqual(syncStateCalls[0][0].service, 'korean_radio_alarm');
  assert.strictEqual(syncStateCalls[0][0].uri, 'https://radio.example.com/stream');
  assert.strictEqual(syncStateCalls[0][0].title, 'KBS Classic FM');
  assert.strictEqual(syncStateCalls[0][0].path, 'https://radio.example.com/stream');
  assert.strictEqual(syncStateCalls[0][0].status, 'playing');
});

test('clearAddPlayTrack resolves dynamic station uri before MPD add', async () => {
  var plugin = createPlugin({
    addToBrowseSources: function () {},
    volumioSetVolume: function () {}
  });

  var mpdCalls = [];
  var syncStateCalls = [];
  plugin.catalog = {
    groups: [
      {
        id: 'kbs',
        name: 'KBS',
        stations: [
          {
            id: 'world-radio',
            name: 'KBS World Radio',
            streamResolver: {
              type: 'kbs-play-api',
              channelId: 'worldradio'
            }
          }
        ]
      }
    ]
  };
  plugin._ensureStationUris && plugin._ensureStationUris();
  plugin._requestJson = function (url) {
    assert.strictEqual(url, 'https://static.api.kbs.co.kr/play/1.2/live/channel/worldradio');
    return Promise.resolve({
      streamUrl: 'https://kbs-world.live/playlist.m3u8'
    });
  };

  plugin.mpdPlugin = {
    sendMpdCommand: function (command, args, cb) {
      mpdCalls.push([command, args]);
      if (typeof cb === 'function') {
        cb(null, true);
        return;
      }
      return Promise.resolve(true);
    },
    getState: function (cb) {
      var state = {
        status: 'playing',
        service: 'mpd',
        uri: 'https://old.example.com/stream',
        title: ''
      };
      if (typeof cb === 'function') {
        cb(null, state);
        return;
      }
      return Promise.resolve(state);
    }
  };

  plugin.commandRouter = {
    stateMachine: {
      syncState: function (state, service, cb) {
        syncStateCalls.push([state, service]);
        if (typeof cb === 'function') {
          cb(null, true);
          return;
        }
        return Promise.resolve(true);
      }
    }
  };

  await plugin.clearAddPlayTrack({
    service: 'korean_radio_alarm',
    uri: STATION_URI_PREFIX + 'world-radio',
    name: 'KBS World Radio'
  });

  assert.strictEqual(mpdCalls[2][0], 'add "https://kbs-world.live/playlist.m3u8"');
  assert.strictEqual(syncStateCalls[0][0].uri, 'https://kbs-world.live/playlist.m3u8');
  assert.strictEqual(syncStateCalls[0][0].path, 'https://kbs-world.live/playlist.m3u8');
  assert.strictEqual(syncStateCalls[0][0].title, 'KBS World Radio');
  assert.strictEqual(syncStateCalls[0][0].service, 'korean_radio_alarm');
});

test('clearAddPlayTrack uses realUri when uri is missing', async () => {
  var plugin = createPlugin({
    addToBrowseSources: function () {},
    volumioSetVolume: function () {}
  });

  var mpdCalls = [];
  var syncStateCalls = [];

  plugin.mpdPlugin = {
    sendMpdCommand: function (command, args, cb) {
      mpdCalls.push([command, args]);
      if (typeof cb === 'function') {
        cb(null, true);
        return;
      }
      return Promise.resolve(true);
    },
    getState: function (cb) {
      var state = {
        status: 'playing',
        service: 'mpd',
        uri: 'https://old.example.com/stream',
        title: ''
      };
      if (typeof cb === 'function') {
        cb(null, state);
        return;
      }
      return Promise.resolve(state);
    }
  };

  plugin.commandRouter = {
    stateMachine: {
      syncState: function (state, service, cb) {
        syncStateCalls.push([state, service]);
        if (typeof cb === 'function') {
          cb(null, true);
          return;
        }
        return Promise.resolve(true);
      }
    }
  };

  await plugin.clearAddPlayTrack({
    service: 'korean_radio_alarm',
    realUri: 'https://direct.example.com/stream',
    name: 'Direct'
  });

  assert.strictEqual(mpdCalls[2][0], 'add "https://direct.example.com/stream"');
  assert.strictEqual(syncStateCalls[0][0].uri, 'https://direct.example.com/stream');
  assert.strictEqual(syncStateCalls[0][0].path, 'https://direct.example.com/stream');
  assert.strictEqual(syncStateCalls[0][0].title, 'Direct');
});
