'use strict';

const test = require('node:test');
const assert = require('assert');

const {
  normalizeSelectValue,
  isValidTime,
  buildCronExpressions,
  stationOptionsFromCatalog,
  findStationByUri
} = require('../lib/alarm');

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
          { id: 'one', name: 'KBS One', streamUrl: 'https://example.com/one', uri: 'korean_radio_alarm://station/one' },
          { id: 'two', name: 'KBS Two', streamUrl: 'https://example.com/two', uri: 'korean_radio_alarm://station/two' }
        ]
      },
      {
        id: 'mbc',
        name: 'MBC',
        stations: [
          { id: 'three', name: 'MBC FM', streamUrl: 'https://example.com/three', uri: 'korean_radio_alarm://station/three' }
        ]
      }
    ]
  });

  assert.deepStrictEqual(options, [
    { value: 'korean_radio_alarm://station/one', label: 'KBS - KBS One' },
    { value: 'korean_radio_alarm://station/two', label: 'KBS - KBS Two' },
    { value: 'korean_radio_alarm://station/three', label: 'MBC - MBC FM' }
  ]);
});

test('findStationByUri resolves both direct ids and uri values', () => {
  const catalog = {
    groups: [
      {
        id: 'news',
        name: 'News',
        stations: [
          { id: 'ytn', name: 'YTN', streamUrl: 'https://example.com/ytn', uri: 'korean_radio_alarm://station/ytn' }
        ]
      }
    ]
  };

  const byUri = findStationByUri(catalog, 'korean_radio_alarm://station/ytn');
  const byUriObject = findStationByUri(catalog, { value: 'korean_radio_alarm://station/ytn', label: 'YTN' });
  const byId = findStationByUri(catalog, 'ytn');
  const missing = findStationByUri(catalog, 'unknown');

  assert.strictEqual(byUri.name, 'YTN');
  assert.strictEqual(byUriObject.name, 'YTN');
  assert.strictEqual(byId.name, 'YTN');
  assert.strictEqual(missing, null);
});
