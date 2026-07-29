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

test('isValidTime accepts 00-23 hours and 1-minute increments', () => {
  assert.strictEqual(isValidTime(0, 0), true);
  assert.strictEqual(isValidTime(23, 55), true);
  assert.strictEqual(isValidTime(12, 25), true);
  assert.strictEqual(isValidTime(12, 59), true);
  assert.strictEqual(isValidTime(12, 60), false);
  assert.strictEqual(isValidTime(0, -1), false);
  assert.strictEqual(isValidTime(24, 0), false);
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

test('getUIConfig provides 3 alarm sections with hydrated 1-minute options', async () => {
  var plugin = createPlugin({
    getLanguage: function () {
      return 'en';
    },
    i18nJson: function () {
      return require('../UIConfig.json');
    }
  });

  var setCalls = [];
  plugin.configManager = createConfigManager({
    alarm_enabled: true,
    alarm_hour: 6,
    alarm_minute: { value: '15', type: 'number' },
    alarm_station_uri: 'korean_radio_alarm://station/classic',
    alarm_volume: { type: 'number', value: '50' },
    monday: { type: 'boolean', value: false },
    tuesday: true,
    wednesday: false,
    thursday: true,
    friday: false,
    saturday: false,
    sunday: false,
    alarm_2_enabled: { value: true, type: 'boolean' },
    alarm_2_hour: { type: 'number', value: 18 },
    alarm_2_minute: { value: 10, type: 'number' },
    alarm_2_station_uri: 'korean_radio_alarm://station/classic',
    alarm_2_volume: { value: 60 },
    alarm_2_monday: { value: false },
    alarm_2_tuesday: { value: true },
    alarm_2_wednesday: { value: false },
    alarm_2_thursday: { value: true },
    alarm_2_friday: { value: false },
    alarm_2_saturday: { value: false },
    alarm_2_sunday: { value: false },
    alarm_3_enabled: true,
    alarm_3_hour: 8,
    alarm_3_minute: 0,
    alarm_3_station_uri: 'korean_radio_alarm://station/classic',
    alarm_3_volume: 35
  }, setCalls);

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

  var ui = await plugin.getUIConfig();

  assert.strictEqual(Array.isArray(ui.sections), true);
  assert.strictEqual(ui.sections.length, 3);
  var section1 = ui.sections[0];
  var section2 = ui.sections[1];
  var section3 = ui.sections[2];
  var slot1Hour = null;
  var slot1Minute = null;
  var slot1MinuteOptions = null;

  for (var i = 0; i < section1.content.length; i++) {
    var item = section1.content[i];
    if (item.id === 'alarm_1_hour') {
      slot1Hour = item.value;
    }
    if (item.id === 'alarm_1_minute') {
      slot1Minute = item.value;
      slot1MinuteOptions = item.options;
    }
  }

  assert.strictEqual(section1.id, 'alarm_settings_1');
  assert.strictEqual(section2.id, 'alarm_settings_2');
  assert.strictEqual(section3.id, 'alarm_settings_3');
  assert.strictEqual(slot1Hour, 6);
  assert.strictEqual(slot1Minute, 15);
  assert.strictEqual(slot1MinuteOptions.length, 60);

  var slot2Enabled = null;
  for (var j = 0; j < section2.content.length; j++) {
    if (section2.content[j].id === 'alarm_2_enabled') {
      slot2Enabled = section2.content[j].value;
      break;
    }
  }

  assert.strictEqual(slot2Enabled, true);
});

test('wrapped config values normalize to plain types for legacy single-alarm migration', () => {
  var plugin = createPlugin({});
  plugin.configManager = createConfigManager({
    alarm_enabled: { type: 'boolean', value: true },
    alarm_hour: { type: 'number', value: '5' },
    alarm_minute: { type: 'number', value: '45' },
    alarm_station_uri: { type: 'string', value: 'korean_radio_alarm://station/classic' },
    alarm_volume: { type: 'number', value: 55 },
    monday: { type: 'boolean', value: false },
    tuesday: { type: 'boolean', value: true },
    wednesday: { type: 'boolean', value: false },
    thursday: { type: 'boolean', value: true },
    friday: { type: 'boolean', value: false },
    saturday: { type: 'boolean', value: false },
    sunday: { type: 'boolean', value: true }
  });

  var stored = plugin._getStoredAlarmConfig('alarm_1');
  assert.strictEqual(stored.alarm_enabled, true);
  assert.strictEqual(stored.alarm_hour, 5);
  assert.strictEqual(stored.alarm_minute, 45);
  assert.strictEqual(stored.alarm_volume, 55);
  assert.strictEqual(stored.alarm_station_uri, 'korean_radio_alarm://station/classic');
  assert.strictEqual(stored.tuesday, true);
});

test('saving one slot does not overwrite config keys for other slots', async () => {
  var calls = [];
  var plugin = createPlugin({
    addToBrowseSources: function () {}
  });

  plugin.configManager = createConfigManager({
    alarm_1_enabled: true,
    alarm_1_hour: 7,
    alarm_1_minute: 5,
    alarm_1_station_uri: 'korean_radio_alarm://station/classic',
    alarm_1_volume: 40,
    alarm_1_monday: true,
    alarm_1_tuesday: true,
    alarm_1_wednesday: true,
    alarm_1_thursday: true,
    alarm_1_friday: true,
    alarm_1_saturday: false,
    alarm_1_sunday: false,
    alarm_2_enabled: true,
    alarm_2_hour: 8,
    alarm_2_minute: 0,
    alarm_2_station_uri: 'korean_radio_alarm://station/classic',
    alarm_2_volume: 30,
    alarm_2_monday: false,
    alarm_2_tuesday: false,
    alarm_2_wednesday: false,
    alarm_2_thursday: false,
    alarm_2_friday: false,
    alarm_2_saturday: false,
    alarm_2_sunday: false
  }, calls);

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
  plugin.mpdPlugin = {
    sendMpdCommand: function () {},
    getState: function () {
      return Promise.resolve({});
    }
  };
  plugin._rescheduleAlarm = function () {
    return {
      scheduled: 0,
      enabledSlots: []
    };
  };

  await plugin.saveAlarm({
    value: {
      alarm_1_hour: 9
    }
  });

  assert.ok(calls.some(function (entry) {
    return entry[0] === 'alarm_1_hour' && entry[1] === 9;
  }));

  var touchesSlot2 = calls.some(function (entry) {
    return entry[0].indexOf('alarm_2_') === 0;
  });
  assert.strictEqual(touchesSlot2, false);
});

test('legacy single-alarm values are projected to alarm_1 when slot keys do not exist', () => {
  var plugin = createPlugin({});
  plugin.configManager = createConfigManager({
    alarm_enabled: true,
    alarm_hour: 9,
    alarm_minute: 20,
    alarm_station_uri: 'korean_radio_alarm://station/classic',
    alarm_volume: 35,
    monday: true,
    tuesday: true,
    wednesday: false,
    thursday: false,
    friday: false,
    saturday: false,
    sunday: true
  });

  var stored = plugin._getStoredAlarmConfig('alarm_1');
  assert.strictEqual(stored.alarm_enabled, true);
  assert.strictEqual(stored.alarm_hour, 9);
  assert.strictEqual(stored.alarm_minute, 20);
  assert.strictEqual(stored.alarm_volume, 35);
  assert.strictEqual(stored.sunday, true);

  var slot3 = plugin._getStoredAlarmConfig('alarm_3');
  assert.strictEqual(slot3.alarm_enabled, false);
});

test('rescheduleAlarm schedules every enabled slot and preserves slot context on callbacks', () => {
  var cron = require('node-cron');
  var originalSchedule = cron.schedule;
  var scheduled = [];

  cron.schedule = function (expr, cb, opts) {
    scheduled.push({
      expr: expr,
      cb: cb,
      opts: opts
    });
    return {
      stop: function () {},
      destroy: function () {}
    };
  };

  try {
    var plugin = createPlugin({});
    plugin.configManager = createConfigManager({
      alarm_1_enabled: true,
      alarm_1_hour: 7,
      alarm_1_minute: 0,
      alarm_1_station_uri: 'korean_radio_alarm://station/classic',
      alarm_1_volume: 45,
      alarm_1_monday: true,
      alarm_1_tuesday: false,
      alarm_1_wednesday: false,
      alarm_1_thursday: false,
      alarm_1_friday: false,
      alarm_1_saturday: false,
      alarm_1_sunday: false,
      alarm_3_enabled: true,
      alarm_3_hour: 7,
      alarm_3_minute: 30,
      alarm_3_station_uri: 'korean_radio_alarm://station/classic',
      alarm_3_volume: 45,
      alarm_3_monday: true,
      alarm_3_tuesday: false,
      alarm_3_wednesday: false,
      alarm_3_thursday: false,
      alarm_3_friday: false,
      alarm_3_saturday: false,
      alarm_3_sunday: false
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

    var fireLog = [];
    plugin._onAlarmFire = function (slotId) {
      fireLog.push(slotId);
      return Promise.resolve(true);
    };

    plugin._rescheduleAlarm();
    assert.strictEqual(scheduled.length, 2);

    scheduled.forEach(function (task) {
      task.cb();
    });

    assert.strictEqual(fireLog.indexOf('alarm_1') >= 0, true);
    assert.strictEqual(fireLog.indexOf('alarm_3') >= 0, true);
  } finally {
    cron.schedule = originalSchedule;
  }
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

function createConfigManager(values, setSpy) {
  var store = values || {};
  return {
    get: function (key, fallback) {
      if (Object.prototype.hasOwnProperty.call(store, key)) {
        return store[key];
      }
      return fallback;
    },
    set: function (key, value) {
      setSpy && setSpy.push([key, value]);
      store[key] = value;
    },
    save: function () {
      return true;
    }
  };
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
  assert.strictEqual(tracks[0].uri, 'https://example.com/stream');
  assert.strictEqual(tracks[0].service, 'mpd');
  assert.strictEqual(tracks[0].stationUri, option.value);
  assert.strictEqual(tracks[0].trackType, 'webradio');
  assert.strictEqual(tracks[0].duration, 0);
  assert.strictEqual(root.navigation.prev.uri, SOURCE_URI);
  assert.strictEqual(groupNavigation.navigation.lists[0].items[0].uri, option.value);
  assert.strictEqual(groupNavigation.navigation.lists[0].items[0].service, 'korean_radio_alarm');
  assert.strictEqual(groupNavigation.navigation.lists[0].items[0].trackType, 'webradio');
  assert.strictEqual(groupNavigation.navigation.lists[0].items[0].duration, 0);
  assert.strictEqual(groupNavigation.navigation.lists[0].items[0].realUri, 'https://example.com/stream');
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
  assert.strictEqual(tracks[0].service, 'mpd');
  assert.strictEqual(tracks[0].trackType, 'webradio');
  assert.strictEqual(tracks[0].duration, 0);
  assert.strictEqual(tracks[0].isStreaming, true);
  assert.strictEqual(tracks[0].album, 'KBS World Radio');
  assert.strictEqual(tracks[0].artist, 'KBS World Radio');
  assert.strictEqual(tracks[0].stationUri, STATION_URI_PREFIX + 'world-radio');
  assert.strictEqual(tracks[0].uri, 'https://kbs-world.live/playlist.m3u8');
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

test('clearAddPlayTrack aligns stream-track metadata to mpd stateMachine.syncState', async () => {
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
  assert.strictEqual(syncStateCalls[0][1], 'mpd');
  assert.strictEqual(syncStateCalls[0][0].service, 'mpd');
  assert.strictEqual(syncStateCalls[0][0].uri, 'https://radio.example.com/stream');
  assert.strictEqual(syncStateCalls[0][0].title, 'KBS Classic FM');
  assert.strictEqual(syncStateCalls[0][0].path, 'https://radio.example.com/stream');
  assert.strictEqual(syncStateCalls[0][0].stationUri, 'korean_radio_alarm://station/classic');
  assert.strictEqual(syncStateCalls[0][0].status, 'playing');
  assert.strictEqual(syncStateCalls[0][0].isStreaming, true);
  assert.strictEqual(syncStateCalls[0][0].trackType, 'webradio');
  assert.strictEqual(syncStateCalls[0][0].duration, 0);
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
  assert.strictEqual(syncStateCalls[0][0].service, 'mpd');
  assert.strictEqual(syncStateCalls[0][0].stationUri, STATION_URI_PREFIX + 'world-radio');
  assert.strictEqual(syncStateCalls[0][0].isStreaming, true);
  assert.strictEqual(syncStateCalls[0][0].trackType, 'webradio');
  assert.strictEqual(syncStateCalls[0][0].duration, 0);
  assert.strictEqual(syncStateCalls[0][1], 'mpd');
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
  assert.strictEqual(syncStateCalls[0][0].service, 'mpd');
  assert.strictEqual(syncStateCalls[0][1], 'mpd');
  assert.strictEqual(syncStateCalls[0][0].isStreaming, true);
  assert.strictEqual(syncStateCalls[0][0].trackType, 'webradio');
  assert.strictEqual(syncStateCalls[0][0].duration, 0);
});
