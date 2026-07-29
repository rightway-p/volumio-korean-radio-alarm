'use strict';

const test = require('node:test');
const assert = require('assert');

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
