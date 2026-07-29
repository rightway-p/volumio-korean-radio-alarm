'use strict';

var fs = require('fs-extra');
var path = require('path');
var libQ = require('kew');
var cron = require('node-cron');
var childProcess = require('child_process');
var VConf = require('v-conf');
var https = require('https');

var AlarmHelpers = require('./lib/alarm');

var PLUGIN_NAME = 'korean_radio_alarm';
var SOURCE_ID = 'korean_radio_alarm';
var SOURCE_URI = AlarmHelpers.SOURCE_URI || 'korean_radio_alarm://';
var STATION_URI_PREFIX = AlarmHelpers.STATION_URI_PREFIX || (SOURCE_URI + 'station/');
var BROWSE_SOURCE_NAME = 'Korean Radio Alarm';
var WEBRADIO_SERVICE = 'webradio';
var KBS_PLAY_API_URL_BASE = 'https://static.api.kbs.co.kr/play/1.2/live/channel/';
var KBS_PLAY_API_AUTHORIZATION = 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJwbGF0Zm9ybUlkIjoia2JzLWhvbWUiLCJ1c2VySWQiOiIiLCJkYXRhIjoiIiwic2NvcGUiOlsiZGVmYXVsdCIsImFkbWluIl0sInRva2VuRXhwaXJlVGltZSI6MjIyNDkxMTMwODIwM30.hb4K_Wn2ekzNO84xfAOrPnj2OyAeRt7HgSr2TzgQvJQ';
var ALARM_SLOT_IDS = ['alarm_1', 'alarm_2', 'alarm_3'];
var WEEKDAY_KEYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

function KoreanRadioAlarm(context) {
  this.context = context;
  this.commandRouter = this.context.coreCommand;
  this.logger = this.context && this.context.logger ? this.context.logger : {
    info: function () {},
    error: function () {}
  };
  this.configManager = this.context.configManager || new VConf();

  this.configFile = null;
  this.catalogFile = path.join(__dirname, 'radio_stations.json');
  this.catalog = { groups: [] };

  this.pluginName = PLUGIN_NAME;
  this.scheduledJobs = [];
  this.alarmConfig = null;
  this.i18n = null;
  this.mpdPlugin = null;
  this.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function safePromise(fn) {
  var defer = libQ.defer();
  var promise;

  try {
    promise = fn();

    if (promise && typeof promise.then === 'function') {
      promise.then(function (value) {
        defer.resolve(value);
      }).catch ? promise.catch(function (err) {
        defer.reject(err);
      }) : promise.fail(function (err) {
        defer.reject(err);
      });
    } else {
      defer.resolve(promise);
    }
  } catch (e) {
    defer.reject(e);
  }

  return defer.promise;
}

function callPluginMethod(context, methodName, args) {
  var defer = libQ.defer();
  var fn = context && context[methodName];

  if (typeof fn !== 'function') {
    defer.resolve(false);
    return defer.promise;
  }

  var consumed = false;
  var callbackCount = fn.length;

  try {
    if (callbackCount > (args ? args.length : 0)) {
      var cb = function (err, result) {
        if (consumed) {
          return;
        }
        consumed = true;
        if (err) {
          defer.reject(err);
        } else {
          defer.resolve(result);
        }
      };

      var invocationArgs = (args || []).concat([cb]);
      var ret = fn.apply(context, invocationArgs);
      if (ret && typeof ret.then === 'function') {
        if (typeof ret.catch === 'function') {
          ret.then(function (value) {
            if (!consumed) {
              consumed = true;
              defer.resolve(value);
            }
          }).catch(function (err) {
            if (!consumed) {
              consumed = true;
              defer.reject(err);
            }
          });
        } else {
          ret.then(function (value) {
            if (!consumed) {
              consumed = true;
              defer.resolve(value);
            }
          }).fail(function (err) {
            if (!consumed) {
              consumed = true;
              defer.reject(err);
            }
          });
        }
      }
    } else {
      var value = fn.apply(context, args || []);
      if (value && typeof value.then === 'function') {
        if (typeof value.catch === 'function') {
          value.then(function (result) {
            defer.resolve(result);
          }).catch(function (err) {
            defer.reject(err);
          });
        } else {
          value.then(function (result) {
            defer.resolve(result);
          }).fail(function (err) {
            defer.reject(err);
          });
        }
      } else {
        defer.resolve(value);
      }
    }
  } catch (e) {
    defer.reject(e);
  }

  return defer.promise;
}

function toLabel(value, width) {
  var str = String(value);
  while (str.length < width) {
    str = '0' + str;
  }
  return str;
}

function stripSlotIdPrefix(fieldId) {
  var match = /^alarm_[1-3]_(.+)$/.exec(fieldId);
  return match ? match[1] : '';
}

function getSlotIdForKey(key) {
  var match = /^alarm_([1-3])_.+$/.exec(key);
  if (!match) {
    return null;
  }
  return 'alarm_' + match[1];
}

function isLegacyAlarmKey(key) {
  return key === 'alarm_enabled' || key === 'alarm_hour' || key === 'alarm_minute' || key === 'alarm_station_uri' || key === 'alarm_volume' || key === 'monday' || key === 'tuesday' || key === 'wednesday' || key === 'thursday' || key === 'friday' || key === 'saturday' || key === 'sunday';
}

function defaultAlarmConfig(alarmSlot, catalog) {
  var defaultStation = AlarmHelpers.firstStationUriFromCatalog(catalog) || '';
  return {
    alarm_enabled: false,
    alarm_hour: 7,
    alarm_minute: 0,
    alarm_station_uri: defaultStation,
    alarm_volume: 45,
    monday: true,
    tuesday: true,
    wednesday: true,
    thursday: true,
    friday: true,
    saturday: false,
    sunday: false
  };
}

function readJsonOrDefault(filePath, fallback) {
  try {
    if (fs.existsSync(filePath)) {
      return fs.readJsonSync(filePath);
    }
  } catch (e) {
    return fallback;
  }

  return fallback;
}

function resolveLanguageCode(commandRouter) {
  var sharedVars = commandRouter && commandRouter.sharedVars ? commandRouter.sharedVars : null;
  if (sharedVars) {
    var sharedLanguage;
    if (typeof sharedVars.get === 'function') {
      sharedLanguage = sharedVars.get('language_code');
    } else if (typeof sharedVars.language_code === 'string') {
      sharedLanguage = sharedVars.language_code;
    }

    if (typeof sharedLanguage === 'string' && sharedLanguage.length > 0) {
      return sharedLanguage;
    }
  }

  var lang = commandRouter && commandRouter.getLanguage ? commandRouter.getLanguage() : null;
  if (typeof lang === 'string' && lang.length > 0) {
    return lang;
  }

  return 'en';
}

function addBrowseSource(context, source) {
  if (!context) {
    return null;
  }

  if (typeof context.addToBrowseSources === 'function') {
    return context.addToBrowseSources(source);
  }

  if (typeof context.volumioAddToBrowseSources === 'function') {
    return context.volumioAddToBrowseSources(source);
  }

  return null;
}

function removeBrowseSource(context, sourceUri) {
  if (!context) {
    return null;
  }

  if (typeof context.removeBrowseSource === 'function') {
    return context.removeBrowseSource(sourceUri);
  }

  if (typeof context.volumioRemoveBrowseSource === 'function') {
    return context.volumioRemoveBrowseSource(sourceUri);
  }

  if (typeof context.volumioRemoveBrowseSources === 'function') {
    return context.volumioRemoveBrowseSources(sourceUri);
  }

  if (typeof context.removeFromBrowseSources === 'function') {
    return context.removeFromBrowseSources(sourceUri);
  }

  return null;
}

KoreanRadioAlarm.prototype.onVolumioStart = function () {
  var configFile = null;

  if (this.commandRouter && this.commandRouter.pluginManager && typeof this.commandRouter.pluginManager.getConfigurationFile === 'function') {
    configFile = this.commandRouter.pluginManager.getConfigurationFile(this.context, 'config.json');
  }

  this.configFile = configFile || path.join(__dirname, 'config.json');
  this.configManager = new VConf();
  this.configManager.loadFile(this.configFile);

  this._loadCatalog();
  return libQ.resolve();
};

KoreanRadioAlarm.prototype.onStart = function () {
  var self = this;

  this._loadCatalog();

  return this._loadI18n()
    .then(function () {
      if (self.commandRouter && self.commandRouter.pluginManager && typeof self.commandRouter.pluginManager.getPlugin === 'function') {
        self.mpdPlugin = self.commandRouter.pluginManager.getPlugin('music_service', 'mpd');
      }

      self._addBrowseSource();
      self._rescheduleAlarm();
    });
};

KoreanRadioAlarm.prototype.onStop = function () {
  this._clearScheduledJobs();
  this._removeBrowseSource();
  return libQ.resolve();
};

KoreanRadioAlarm.prototype.getConfigurationFiles = function () {
  return ['config.json'];
};

KoreanRadioAlarm.prototype.getUIConfig = function () {
  var self = this;
  var lang = resolveLanguageCode(this.commandRouter);

  return safePromise(function () {
    if (!self.commandRouter || typeof self.commandRouter.i18nJson !== 'function') {
      return readJsonOrDefault(path.join(__dirname, 'UIConfig.json'), {});
    }

    var requested = path.join(__dirname, 'i18n', 'strings_' + lang + '.json');
    var fallback = path.join(__dirname, 'i18n', 'strings_en.json');
    return self.commandRouter.i18nJson(requested, fallback, path.join(__dirname, 'UIConfig.json'));
  }).then(function (uiConfig) {
    if (!uiConfig || !uiConfig.sections || !Array.isArray(uiConfig.sections)) {
      return uiConfig;
    }

    var stationOptions = AlarmHelpers.stationOptionsFromCatalog(self.catalog);
    var hourOptions = [];
    for (var h = 0; h <= 23; h++) {
      hourOptions.push({ value: h, label: toLabel(h, 2) });
    }

    var minuteOptions = [];
    for (var m = 0; m <= 59; m++) {
      minuteOptions.push({ value: m, label: toLabel(m, 2) });
    }

    var volumeOptions = [];
    for (var v = 0; v <= 100; v += 5) {
      volumeOptions.push({ value: v, label: String(v) });
    }

    uiConfig.sections.forEach(function (section) {
      if (!section || !Array.isArray(section.content)) {
        return;
      }

      var match = /_([1-3])$/.exec(section.id || '');
      var slotId = match ? 'alarm_' + match[1] : null;
      if (!slotId) {
        return;
      }

      var alarmConfig = self._getStoredAlarmConfig(slotId);
      var contentById = {};
      section.content.forEach(function (item) {
        if (item && item.id) {
          contentById[item.id] = item;
        }
      });

      var minute = alarmConfig.alarm_minute;
      var hour = alarmConfig.alarm_hour;
      var volume = alarmConfig.alarm_volume;
      var stationUri = alarmConfig.alarm_station_uri;

      if (!stationUri && stationOptions.length > 0) {
        stationUri = stationOptions[0].value;
      }

      var enabledId = slotId + '_enabled';
      var hourId = slotId + '_hour';
      var minuteId = slotId + '_minute';
      var stationId = slotId + '_station_uri';
      var volumeId = slotId + '_volume';
      var fieldIds = {
        monday: slotId + '_monday',
        tuesday: slotId + '_tuesday',
        wednesday: slotId + '_wednesday',
        thursday: slotId + '_thursday',
        friday: slotId + '_friday',
        saturday: slotId + '_saturday',
        sunday: slotId + '_sunday'
      };

      if (contentById[enabledId]) {
        contentById[enabledId].value = !!alarmConfig.alarm_enabled;
      }

      if (contentById[hourId]) {
        contentById[hourId].value = hour;
        contentById[hourId].options = hourOptions;
      }

      if (contentById[minuteId]) {
        contentById[minuteId].value = minute;
        contentById[minuteId].options = minuteOptions;
      }

      if (contentById[volumeId]) {
        contentById[volumeId].value = volume;
        contentById[volumeId].options = volumeOptions;
      }

      if (contentById[stationId]) {
        contentById[stationId].value = stationUri;
        contentById[stationId].options = stationOptions;
      }

      if (contentById[fieldIds.monday]) {
        contentById[fieldIds.monday].value = !!alarmConfig.monday;
      }
      if (contentById[fieldIds.tuesday]) {
        contentById[fieldIds.tuesday].value = !!alarmConfig.tuesday;
      }
      if (contentById[fieldIds.wednesday]) {
        contentById[fieldIds.wednesday].value = !!alarmConfig.wednesday;
      }
      if (contentById[fieldIds.thursday]) {
        contentById[fieldIds.thursday].value = !!alarmConfig.thursday;
      }
      if (contentById[fieldIds.friday]) {
        contentById[fieldIds.friday].value = !!alarmConfig.friday;
      }
      if (contentById[fieldIds.saturday]) {
        contentById[fieldIds.saturday].value = !!alarmConfig.saturday;
      }
      if (contentById[fieldIds.sunday]) {
        contentById[fieldIds.sunday].value = !!alarmConfig.sunday;
      }
    });

    return uiConfig;
  });
};

KoreanRadioAlarm.prototype.saveAlarm = function (data) {
  var self = this;
  data = data || {};
  if (data.value && typeof data.value === 'object') {
    data = data.value;
  }

  var slotId = this._extractSlotIdFromPayload(data);
  if (!slotId) {
    slotId = 'alarm_1';
  }

  var prefix = slotId + '_';
  var existing = this._getStoredAlarmConfig(slotId);
  var useLegacyPayload = slotId === 'alarm_1' &&
    (Object.prototype.hasOwnProperty.call(data, 'alarm_enabled') ||
      Object.prototype.hasOwnProperty.call(data, 'alarm_hour') ||
      Object.prototype.hasOwnProperty.call(data, 'alarm_minute') ||
      Object.prototype.hasOwnProperty.call(data, 'alarm_station_uri') ||
      Object.prototype.hasOwnProperty.call(data, 'alarm_volume') ||
      Object.prototype.hasOwnProperty.call(data, 'monday') ||
      Object.prototype.hasOwnProperty.call(data, 'tuesday') ||
      Object.prototype.hasOwnProperty.call(data, 'wednesday') ||
      Object.prototype.hasOwnProperty.call(data, 'thursday') ||
      Object.prototype.hasOwnProperty.call(data, 'friday') ||
      Object.prototype.hasOwnProperty.call(data, 'saturday') ||
      Object.prototype.hasOwnProperty.call(data, 'sunday'));

  var stationUri = this._normalizeStationValue(useLegacyPayload ? data.alarm_station_uri : data[prefix + 'station_uri']);
  var station = stationUri ? AlarmHelpers.findStationByUri(this.catalog, stationUri) : null;

  var setEnabled = Object.prototype.hasOwnProperty.call(data, prefix + 'enabled') ||
    (useLegacyPayload && Object.prototype.hasOwnProperty.call(data, 'alarm_enabled'));
  var setHour = Object.prototype.hasOwnProperty.call(data, prefix + 'hour') ||
    (useLegacyPayload && Object.prototype.hasOwnProperty.call(data, 'alarm_hour'));
  var setMinute = Object.prototype.hasOwnProperty.call(data, prefix + 'minute') ||
    (useLegacyPayload && Object.prototype.hasOwnProperty.call(data, 'alarm_minute'));
  var setVolume = Object.prototype.hasOwnProperty.call(data, prefix + 'volume') ||
    (useLegacyPayload && Object.prototype.hasOwnProperty.call(data, 'alarm_volume'));
  var setStation = Object.prototype.hasOwnProperty.call(data, prefix + 'station_uri') ||
    (useLegacyPayload && Object.prototype.hasOwnProperty.call(data, 'alarm_station_uri'));

  var enabled = this._normalizeBooleanValue(setEnabled ? (useLegacyPayload ? data.alarm_enabled : data[prefix + 'enabled']) : existing.alarm_enabled);
  var hour = AlarmHelpers.normalizeSelectValue(setHour ? (useLegacyPayload ? data.alarm_hour : data[prefix + 'hour']) : existing.alarm_hour, 0, 23, 1, existing.alarm_hour);
  var minute = AlarmHelpers.normalizeSelectValue(setMinute ? (useLegacyPayload ? data.alarm_minute : data[prefix + 'minute']) : existing.alarm_minute, 0, 59, 1, existing.alarm_minute);
  var volume = AlarmHelpers.normalizeSelectValue(setVolume ? (useLegacyPayload ? data.alarm_volume : data[prefix + 'volume']) : existing.alarm_volume, 0, 100, 5, existing.alarm_volume);
  var weekdays = this._getWeekdayValuesFromPayload(slotId, data, existing);

  if (!station) {
    station = { uri: existing.alarm_station_uri };
    if (setStation) {
      var noStation = this._t('ALARM.NO_STATION', 'No valid station');
      this._pushToast('error', this._t('ALARM.TITLE', 'Korean Radio Alarm'), noStation);
      return libQ.reject(new Error(noStation));
    }
  }

  if ((setHour || setMinute || setEnabled || setVolume || setStation) && (!AlarmHelpers.isValidTime(hour, minute) || volume === null)) {
    var msg = this._t('ALARM.SAVE_ERROR', this._t('ALARM.SAVE_ERROR', 'Failed to save alarm settings'));
    this._pushToast('error', this._t('ALARM.TITLE', 'Korean Radio Alarm'), msg);
    return libQ.reject(new Error(msg));
  }

  if (setEnabled) {
    this.configManager.set(prefix + 'enabled', !!enabled);
  }
  if (setHour) {
    this.configManager.set(prefix + 'hour', hour);
  }
  if (setMinute) {
    this.configManager.set(prefix + 'minute', minute);
  }
  if (setVolume) {
    this.configManager.set(prefix + 'volume', volume);
  }
  if (setStation) {
    this.configManager.set(prefix + 'station_uri', station.uri || stationUri);
  }

  WEEKDAY_KEYS.forEach(function (weekday) {
    var field = prefix + weekday;
    var legacyField = weekday;

    if (Object.prototype.hasOwnProperty.call(data, field)) {
      self.configManager.set(field, self._normalizeBooleanValue(data[field]));
      return;
    }

    if (slotId === 'alarm_1' && Object.prototype.hasOwnProperty.call(data, legacyField)) {
      self.configManager.set(field, self._normalizeBooleanValue(data[legacyField]));
    }
  });

  this._persistConfig();
  this.alarmConfig = this._getStoredAlarmConfig(slotId);
  this._rescheduleAlarm();
  this._pushToast('success', this._t('ALARM.TITLE', 'Korean Radio Alarm'), this._t('ALARM.SAVE_SUCCESS', 'Alarm settings saved and rescheduled'));

  return libQ.resolve({
    success: true,
    slot: slotId,
    alarm: this.alarmConfig
  });
};

KoreanRadioAlarm.prototype.explodeUri = function (uri) {
  var station = AlarmHelpers.findStationByUri(this.catalog, uri);
  if (!station) {
    return libQ.reject(new Error('Invalid uri'));
  }

  return this._resolveStationStreamUrl(station).then(function (resolvedStreamUrl) {
    var stationUri = station.uri || (STATION_URI_PREFIX + station.id);
    var track = {
      service: 'mpd',
      type: 'track',
      stationUri: stationUri,
      trackType: 'webradio',
      duration: 0,
      isStreaming: true,
      album: station.name,
      artist: station.name,
      uri: resolvedStreamUrl,
      realUri: resolvedStreamUrl,
      path: resolvedStreamUrl,
      name: station.name,
      title: station.name
    };

    return [track];
  });
};

KoreanRadioAlarm.prototype.handleBrowseUri = function (uri) {
  uri = uri || SOURCE_URI;

  if (uri === SOURCE_URI) {
    return this._buildRootNavigation();
  }

  if (uri.indexOf(SOURCE_URI + 'group/') === 0) {
    var groupId = decodeURIComponent(uri.substring((SOURCE_URI + 'group/').length));
    return this._buildGroupNavigation(groupId);
  }

  return this._buildRootNavigation();
};

KoreanRadioAlarm.prototype.clearAddPlayTrack = function (track) {
  if (!this.mpdPlugin) {
    var noMpd = this._t('ALARM.NO_MPD', 'MPD is unavailable');
    this._pushToast('error', this._t('ALARM.TITLE', 'Korean Radio Alarm'), noMpd);
    return libQ.reject(new Error(noMpd));
  }

  var playTrack = track;
  if (!playTrack || typeof playTrack !== 'object') {
    return libQ.reject(new Error(this._t('ALARM.NO_URI', 'No track URI')));
  }

  var hasUri = typeof playTrack.uri === 'string' && playTrack.uri.length > 0;
  var hasRealUri = typeof playTrack.realUri === 'string' && playTrack.realUri.length > 0;

  if (!hasUri && !hasRealUri) {
    return libQ.reject(new Error(this._t('ALARM.NO_URI', 'No track URI')));
  }

  var self = this;
  var serviceName = typeof playTrack.service === 'string' && playTrack.service.length > 0 ? playTrack.service : PLUGIN_NAME;
  var syncService = serviceName === PLUGIN_NAME || serviceName === WEBRADIO_SERVICE ? 'mpd' : serviceName;

  return self._preparePlayTrackForPlayback(playTrack)
    .then(function (preparedTrack) {
      playTrack = preparedTrack;

      if (!playTrack.realUri) {
        playTrack.realUri = playTrack.uri;
      }

      return callPluginMethod(self.mpdPlugin, 'sendMpdCommand', ['stop', []]);
    })
    .then(function () {
      return callPluginMethod(self.mpdPlugin, 'sendMpdCommand', ['clear', []]);
    })
    .then(function () {
      return callPluginMethod(self.mpdPlugin, 'sendMpdCommand', ['add "' + playTrack.realUri + '"', []]);
    })
    .then(function () {
      return callPluginMethod(self.mpdPlugin, 'sendMpdCommand', ['play', []]);
    })
    .then(function () {
      if (!self.commandRouter.stateMachine || typeof self.commandRouter.stateMachine.syncState !== 'function') {
        return true;
      }

      if (typeof self.mpdPlugin.getState !== 'function') {
        return true;
      }

      return callPluginMethod(self.mpdPlugin, 'getState', []).then(function (state) {
        if (!state) {
          return true;
        }

        state.service = syncService;
        state.title = playTrack.name || playTrack.title || state.title;
        if (syncService === 'mpd') {
          state.uri = playTrack.realUri || playTrack.uri || state.uri;
        } else {
          state.uri = playTrack.uri || playTrack.realUri || state.uri;
        }
        state.path = playTrack.realUri || playTrack.path || state.path;
        state.trackType = playTrack.trackType || 'webradio';
        state.isStreaming = playTrack.isStreaming !== undefined ? playTrack.isStreaming : true;
        state.duration = typeof playTrack.duration === 'number' ? playTrack.duration : 0;
        if (playTrack.stationUri) {
          state.stationUri = playTrack.stationUri;
        } else if (playTrack.pluginUri) {
          state.stationUri = playTrack.pluginUri;
        } else if (typeof playTrack.uri === 'string' && playTrack.uri.indexOf(SOURCE_URI) === 0) {
          state.stationUri = playTrack.uri;
        }

        if (playTrack.pluginUri) {
          state.pluginUri = playTrack.pluginUri;
        } else if (playTrack.stationUri) {
          state.pluginUri = playTrack.stationUri;
        }
        if (!state.album) {
          state.album = playTrack.album || playTrack.name;
        }
        if (!state.artist) {
          state.artist = playTrack.artist || playTrack.name;
        }

        return callPluginMethod(self.commandRouter.stateMachine, 'syncState', [state, syncService]);
      });
    });
};

KoreanRadioAlarm.prototype._preparePlayTrackForPlayback = function (track) {
  var self = this;

  if (!track) {
    return libQ.reject(new Error(this._t('ALARM.NO_URI', 'No track URI')));
  }

  var hasUri = typeof track.uri === 'string' && track.uri.length > 0;
  var hasRealUri = typeof track.realUri === 'string' && track.realUri.length > 0;

  if (!hasUri && !hasRealUri) {
    return libQ.reject(new Error(this._t('ALARM.NO_URI', 'No track URI')));
  }

  var shouldResolve = typeof track.uri === 'string' &&
    track.uri.indexOf(STATION_URI_PREFIX) === 0 &&
    (!hasRealUri || track.realUri === track.uri);

  if (!shouldResolve) {
    return libQ.resolve(track);
  }

  var station = AlarmHelpers.findStationByUri(this.catalog, track.uri);
  if (!station) {
    return libQ.resolve(track);
  }

  return this._resolveStationStreamUrl(station).then(function (resolvedStreamUrl) {
    track.realUri = resolvedStreamUrl;
    track.path = resolvedStreamUrl;
    return track;
  });
};

KoreanRadioAlarm.prototype._onAlarmFire = function (slotId) {
  var self = this;
  var alarmConfig = this._getStoredAlarmConfig(slotId || 'alarm_1');
  if (!alarmConfig || !alarmConfig.alarm_enabled) {
    return libQ.resolve(false);
  }

  var station = AlarmHelpers.findStationByUri(this.catalog, alarmConfig.alarm_station_uri);
  if (!station) {
    this._pushToast('error', this._t('ALARM.TITLE', 'Korean Radio Alarm'), this._t('ALARM.NO_STATION', 'No valid station'));
    return libQ.resolve(false);
  }

  return this._setAlarmVolume(alarmConfig.alarm_volume)
    .then(function () {
      return self.explodeUri(station.uri || (STATION_URI_PREFIX + station.id));
    })
    .then(function (tracks) {
      if (!Array.isArray(tracks) || tracks.length === 0) {
        return libQ.reject(new Error(self._t('ALARM.NO_URI', 'No track URI')));
      }
      return self.clearAddPlayTrack(tracks[0]);
    });
};

KoreanRadioAlarm.prototype._loadI18n = function () {
  var self = this;
  var lang = resolveLanguageCode(this.commandRouter);
  var requested = path.join(__dirname, 'i18n', 'strings_' + lang + '.json');
  var fallback = path.join(__dirname, 'i18n', 'strings_en.json');

  var i18n = readJsonOrDefault(requested, null);
  if (!i18n || typeof i18n !== 'object') {
    i18n = readJsonOrDefault(fallback, {});
  }

  if (!i18n || typeof i18n !== 'object') {
    i18n = {};
  }

  self.i18n = i18n;
  return libQ.resolve(self.i18n);
};

KoreanRadioAlarm.prototype._t = function (path, fallback) {
  if (!this.i18n || !path) {
    return fallback || path;
  }

  var value = this.i18n;
  var parts = path.split('.');

  for (var i = 0; i < parts.length; i++) {
    if (!value || typeof value !== 'object' || !(parts[i] in value)) {
      return fallback || path;
    }
    value = value[parts[i]];
  }

  if (value === undefined || value === null) {
    return fallback || path;
  }

  return value;
};

KoreanRadioAlarm.prototype._pushToast = function (type, title, message) {
  if (!this.commandRouter || typeof this.commandRouter.pushToastMessage !== 'function') {
    return;
  }

  this.commandRouter.pushToastMessage(type, title, message);
};

KoreanRadioAlarm.prototype._unwrapConfigValue = function (value) {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'object' && value !== null && value.value !== undefined) {
    return this._unwrapConfigValue(value.value);
  }

  return value;
};

KoreanRadioAlarm.prototype._extractSlotIdFromPayload = function (data) {
  var slotId = null;
  var keys = Object.keys(data || {});

  keys.forEach(function (key) {
    if (isLegacyAlarmKey(key)) {
      slotId = 'alarm_1';
      return;
    }

    var match = /^alarm_([1-3])_/.exec(key);
    if (match) {
      slotId = 'alarm_' + match[1];
    }
  });

  return slotId;
};

KoreanRadioAlarm.prototype._getWeekdayValuesFromPayload = function (slotId, data, existing) {
  var weekdays = {};
  var prefix = slotId + '_';
  var self = this;

  WEEKDAY_KEYS.forEach(function (weekday) {
    var key = prefix + weekday;
    var legacyKey = weekday;

    if (slotId === 'alarm_1' && data && Object.prototype.hasOwnProperty.call(data, legacyKey)) {
      weekdays[weekday] = self._normalizeBooleanValue(data[legacyKey]);
      return;
    }

    if (data && Object.prototype.hasOwnProperty.call(data, key)) {
      weekdays[weekday] = self._normalizeBooleanValue(data[key]);
      return;
    }
    weekdays[weekday] = existing[weekday];
  }, this);

  return weekdays;
};

KoreanRadioAlarm.prototype._persistConfig = function () {
  if (!this.configManager || typeof this.configManager.save !== 'function') {
    return;
  }

  this.configManager.save();
};

KoreanRadioAlarm.prototype._normalizeBooleanValue = function (value) {
  value = this._unwrapConfigValue(value);
  if (typeof value === 'string') {
    if (value === 'false') {
      return false;
    }
    if (value === 'true') {
      return true;
    }
  }

  return !!value;
};

KoreanRadioAlarm.prototype._normalizeStationValue = function (value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    value = this._unwrapConfigValue(value);
    if (value === null || value === undefined) {
      return '';
    }
  }

  return String(value);
};

KoreanRadioAlarm.prototype._hasSlotConfigValues = function (slotId) {
  var prefix = slotId + '_';
  return ALARM_SLOT_IDS.indexOf(slotId) >= 0 && (
    this.configManager.get(prefix + 'enabled', undefined) !== undefined ||
    this.configManager.get(prefix + 'hour', undefined) !== undefined ||
    this.configManager.get(prefix + 'minute', undefined) !== undefined ||
    this.configManager.get(prefix + 'station_uri', undefined) !== undefined ||
    this.configManager.get(prefix + 'volume', undefined) !== undefined ||
    this.configManager.get(prefix + 'monday', undefined) !== undefined ||
    this.configManager.get(prefix + 'tuesday', undefined) !== undefined ||
    this.configManager.get(prefix + 'wednesday', undefined) !== undefined ||
    this.configManager.get(prefix + 'thursday', undefined) !== undefined ||
    this.configManager.get(prefix + 'friday', undefined) !== undefined ||
    this.configManager.get(prefix + 'saturday', undefined) !== undefined ||
    this.configManager.get(prefix + 'sunday', undefined) !== undefined
  );
};

KoreanRadioAlarm.prototype._hasLegacyAlarmValues = function () {
  return this.configManager.get('alarm_enabled', undefined) !== undefined ||
    this.configManager.get('alarm_hour', undefined) !== undefined ||
    this.configManager.get('alarm_minute', undefined) !== undefined ||
    this.configManager.get('alarm_station_uri', undefined) !== undefined ||
    this.configManager.get('alarm_volume', undefined) !== undefined ||
    this.configManager.get('monday', undefined) !== undefined ||
    this.configManager.get('tuesday', undefined) !== undefined ||
    this.configManager.get('wednesday', undefined) !== undefined ||
    this.configManager.get('thursday', undefined) !== undefined ||
    this.configManager.get('friday', undefined) !== undefined ||
    this.configManager.get('saturday', undefined) !== undefined ||
    this.configManager.get('sunday', undefined) !== undefined;
};

KoreanRadioAlarm.prototype._rescheduleAlarm = function () {
  this._clearScheduledJobs();

  var self = this;
  var scheduleCount = 0;
  var nowEnabled = [];
  this.alarmConfig = {};

  ALARM_SLOT_IDS.forEach(function (slotId) {
    var alarmConfig = self._getStoredAlarmConfig(slotId);
    self.alarmConfig[slotId] = alarmConfig;

    if (!alarmConfig.alarm_enabled) {
      return;
    }

    var expressions = AlarmHelpers.buildCronExpressions(
      alarmConfig.alarm_hour,
      alarmConfig.alarm_minute,
      {
        monday: alarmConfig.monday,
        tuesday: alarmConfig.tuesday,
        wednesday: alarmConfig.wednesday,
        thursday: alarmConfig.thursday,
        friday: alarmConfig.friday,
        saturday: alarmConfig.saturday,
        sunday: alarmConfig.sunday
      }
    );

    expressions.forEach(function (expr) {
      var task = cron.schedule(expr, function () {
        self._onAlarmFire(slotId);
      }, {
        timezone: self.timezone,
        scheduled: true
      });

      self.scheduledJobs.push(task);
      scheduleCount += 1;
      nowEnabled.push(slotId);
    });
  });

  return {
    scheduled: scheduleCount,
    enabledSlots: nowEnabled
  };
};

KoreanRadioAlarm.prototype._clearScheduledJobs = function () {
  if (!Array.isArray(this.scheduledJobs)) {
    this.scheduledJobs = [];
    return;
  }

  this.scheduledJobs.forEach(function (job) {
    if (!job) {
      return;
    }

    if (typeof job.stop === 'function') {
      job.stop();
    }

    if (typeof job.destroy === 'function') {
      job.destroy();
    }
  });

  this.scheduledJobs = [];
};

KoreanRadioAlarm.prototype._addBrowseSource = function () {
  if (!this.commandRouter) {
    return;
  }

  var entry = {
    name: this._t('ALARM.TITLE', BROWSE_SOURCE_NAME),
    uri: SOURCE_URI,
    plugin_name: PLUGIN_NAME,
    plugin_type: 'music_service',
    source: SOURCE_ID,
    icon: 'fa-clock-o',
    sourceicon: 'fa-clock-o',
    albumart: '/albumart?source=' + SOURCE_ID
  };

  addBrowseSource(this.commandRouter, entry);
};

KoreanRadioAlarm.prototype._removeBrowseSource = function () {
  if (!this.commandRouter) {
    return;
  }

  removeBrowseSource(this.commandRouter, SOURCE_URI);
};

KoreanRadioAlarm.prototype._setAlarmVolume = function (volume) {
  if (!Number.isInteger(volume) || volume < 0 || volume > 100) {
    return libQ.reject(new Error(this._t('ALARM.BAD_VOLUME', 'Invalid volume')));
  }

  if (!this.commandRouter) {
    return libQ.resolve();
  }

  if (typeof this.commandRouter.volumiosetvolume === 'function') {
    return safePromise(function () {
      return this.commandRouter.volumiosetvolume(volume);
    }.bind(this));
  }

  if (typeof this.commandRouter.volumioSetVolume === 'function') {
    return safePromise(function () {
      return this.commandRouter.volumioSetVolume(volume);
    }.bind(this));
  }

  var defer = libQ.defer();
  childProcess.exec('volumio volume ' + volume, function (err) {
    if (err) {
      defer.reject(err);
      return;
    }
    defer.resolve(true);
  });
  return defer.promise;
};

KoreanRadioAlarm.prototype._buildRootNavigation = function () {
  var groups = Array.isArray(this.catalog.groups) ? this.catalog.groups : [];
  var items = groups.map(function (group) {
    return {
      service: PLUGIN_NAME,
      type: 'folder',
      title: group.name || group.id,
      icon: 'fa-broadcast-tower',
      uri: SOURCE_URI + 'group/' + encodeURIComponent(group.id)
    };
  });

  return libQ.resolve({
    title: this._t('BROWSE.ROOT', 'Korean Radio'),
    navigation: {
      lists: [
        {
          title: this._t('BROWSE.GROUPS', 'Radio groups'),
          icon: 'fa-broadcast-tower',
          availableListViews: ['list'],
          items: items
        }
      ],
      prev: {
        uri: SOURCE_URI
      }
    },
    prev: {
      uri: SOURCE_URI
    },
    path: SOURCE_URI,
    isFolder: true,
    plugin: this.pluginName
  });
};

KoreanRadioAlarm.prototype._buildGroupNavigation = function (groupId) {
  var groups = Array.isArray(this.catalog.groups) ? this.catalog.groups : [];
  var target = null;

  for (var i = 0; i < groups.length; i++) {
    if (groups[i].id === groupId) {
      target = groups[i];
      break;
    }
  }

  if (!target) {
    return this._buildRootNavigation();
  }

  var stations = Array.isArray(target.stations) ? target.stations : [];
  var items = stations.map(function (station) {
    var streamPath = station.streamUrl || '';
    var item = {
      service: PLUGIN_NAME,
      type: 'song',
      stationUri: STATION_URI_PREFIX + station.id,
      trackType: 'webradio',
      duration: 0,
      isStreaming: true,
      title: station.name,
      album: target.name || target.id,
      artist: target.name || target.id,
      icon: 'fa-broadcast-tower',
      uri: station.uri || (STATION_URI_PREFIX + station.id),
      name: station.name
    };

    if (streamPath && streamPath.length > 0) {
      item.path = streamPath;
      item.realUri = streamPath;
    }

    return item;
  });

  return libQ.resolve({
    title: target.name || target.id,
    navigation: {
      prev: {
        uri: SOURCE_URI
      },
      lists: [
        {
          title: target.name || target.id,
          icon: 'fa-broadcast-tower',
          availableListViews: ['list'],
          items: items
        }
      ]
    }
  });
};

KoreanRadioAlarm.prototype._ensureStationUris = function () {
  if (!this.catalog || !Array.isArray(this.catalog.groups)) {
    return;
  }

  this.catalog.groups.forEach(function (group) {
    if (!Array.isArray(group.stations)) {
      return;
    }

    group.stations.forEach(function (station) {
      if (!station.uri && station.id) {
        station.uri = STATION_URI_PREFIX + station.id;
      }
    });
  });
};

KoreanRadioAlarm.prototype._loadCatalog = function () {
  this.catalog = readJsonOrDefault(this.catalogFile, { groups: [] });
  this._ensureStationUris();
};

KoreanRadioAlarm.prototype._requestJson = function (url, options) {
  var headers = options && options.headers ? options.headers : {};
  var defer = libQ.defer();
  var consumed = false;

  var done = function (err, result) {
    if (consumed) {
      return;
    }
    consumed = true;
    if (err) {
      defer.reject(err);
      return;
    }
    defer.resolve(result);
  };

  if (typeof url !== 'string' || !url) {
    return libQ.reject(new Error('Missing request url'));
  }

  var req;
  try {
    req = https.get(url, { headers: headers }, function (res) {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        done(new Error('KBS play api request failed with status ' + res.statusCode));
        res.resume();
        return;
      }

      var body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
        body += chunk;
      });
      res.on('end', function () {
        try {
          done(null, JSON.parse(body));
        } catch (e) {
          done(e);
        }
      });
      res.on('error', function (err) {
        done(err);
      });
    });
  } catch (e) {
    return done(e), defer.promise;
  }

  req.on('error', function (err) {
    done(err);
  });
  req.setTimeout(10000, function () {
    done(new Error('KBS play api request timeout'));
    req.destroy();
  });
  return defer.promise;
};

KoreanRadioAlarm.prototype._resolveStationStreamUrl = function (station) {
  var self = this;

  if (!station) {
    return libQ.reject(new Error('Invalid station'));
  }

  if (!station.streamResolver || !station.streamResolver.type) {
    if (typeof station.streamUrl === 'string' && station.streamUrl.length > 0) {
      return libQ.resolve(station.streamUrl);
    }
    return libQ.reject(new Error('No static stream URL for station ' + station.id));
  }

  if (station.streamResolver.type === 'kbs-play-api') {
    var channelId = station.streamResolver.channelId;

    if (typeof channelId !== 'string' || !channelId) {
      return libQ.reject(new Error('Missing channelId for KBS play resolver on station ' + station.id));
    }

    var endpoint = KBS_PLAY_API_URL_BASE + encodeURIComponent(channelId);
    var headers = {
      Authorization: KBS_PLAY_API_AUTHORIZATION
    };

    return safePromise(function () {
      return self._requestJson(endpoint, { headers: headers });
    }).then(function (payload) {
      if (!payload || typeof payload.streamUrl !== 'string' || !payload.streamUrl) {
        var invalid = new Error('Invalid KBS play api response for station ' + station.id);
        if (self.logger && typeof self.logger.error === 'function') {
          self.logger.error(invalid.message);
        }
        throw invalid;
      }

      return payload.streamUrl;
    }).fail(function (err) {
      if (self.logger && typeof self.logger.error === 'function') {
        var message = err && err.message ? err.message : 'Unknown error';
        self.logger.error('Failed to resolve stream URL for station ' + station.id + ': ' + message);
      }
      throw err;
    });
  }

  return libQ.reject(new Error('Unsupported stream resolver type ' + station.streamResolver.type + ' for station ' + station.id));
};

KoreanRadioAlarm.prototype._getStoredAlarmConfig = function (slotId) {
  slotId = slotId || 'alarm_1';
  var prefix = slotId + '_';
  var defaultStation = AlarmHelpers.firstStationUriFromCatalog(this.catalog) || '';
  var defaults = defaultAlarmConfig(slotId, this.catalog);

  if (slotId === 'alarm_1' && !this._hasSlotConfigValues(slotId) && this._hasLegacyAlarmValues()) {
    defaults = {
      alarm_enabled: this._unwrapConfigValue(this.configManager.get('alarm_enabled', defaults.alarm_enabled)),
      alarm_hour: this._unwrapConfigValue(this.configManager.get('alarm_hour', defaults.alarm_hour)),
      alarm_minute: this._unwrapConfigValue(this.configManager.get('alarm_minute', defaults.alarm_minute)),
      alarm_station_uri: this._unwrapConfigValue(this.configManager.get('alarm_station_uri', defaults.alarm_station_uri)),
      alarm_volume: this._unwrapConfigValue(this.configManager.get('alarm_volume', defaults.alarm_volume)),
      monday: this._unwrapConfigValue(this.configManager.get('monday', defaults.monday)),
      tuesday: this._unwrapConfigValue(this.configManager.get('tuesday', defaults.tuesday)),
      wednesday: this._unwrapConfigValue(this.configManager.get('wednesday', defaults.wednesday)),
      thursday: this._unwrapConfigValue(this.configManager.get('thursday', defaults.thursday)),
      friday: this._unwrapConfigValue(this.configManager.get('friday', defaults.friday)),
      saturday: this._unwrapConfigValue(this.configManager.get('saturday', defaults.saturday)),
      sunday: this._unwrapConfigValue(this.configManager.get('sunday', defaults.sunday))
    };
  } else {
    defaults = {
      alarm_enabled: this._unwrapConfigValue(this.configManager.get(prefix + 'enabled', defaults.alarm_enabled)),
      alarm_hour: this._unwrapConfigValue(this.configManager.get(prefix + 'hour', defaults.alarm_hour)),
      alarm_minute: this._unwrapConfigValue(this.configManager.get(prefix + 'minute', defaults.alarm_minute)),
      alarm_station_uri: this._unwrapConfigValue(this.configManager.get(prefix + 'station_uri', defaults.alarm_station_uri)),
      alarm_volume: this._unwrapConfigValue(this.configManager.get(prefix + 'volume', defaults.alarm_volume)),
      monday: this._unwrapConfigValue(this.configManager.get(prefix + 'monday', defaults.monday)),
      tuesday: this._unwrapConfigValue(this.configManager.get(prefix + 'tuesday', defaults.tuesday)),
      wednesday: this._unwrapConfigValue(this.configManager.get(prefix + 'wednesday', defaults.wednesday)),
      thursday: this._unwrapConfigValue(this.configManager.get(prefix + 'thursday', defaults.thursday)),
      friday: this._unwrapConfigValue(this.configManager.get(prefix + 'friday', defaults.friday)),
      saturday: this._unwrapConfigValue(this.configManager.get(prefix + 'saturday', defaults.saturday)),
      sunday: this._unwrapConfigValue(this.configManager.get(prefix + 'sunday', defaults.sunday))
    };
  }

  var stored = {
    alarm_enabled: this._normalizeBooleanValue(defaults.alarm_enabled),
    alarm_hour: AlarmHelpers.normalizeSelectValue(defaults.alarm_hour, 0, 23, 1, defaults.alarm_hour),
    alarm_minute: AlarmHelpers.normalizeSelectValue(defaults.alarm_minute, 0, 59, 1, defaults.alarm_minute),
    alarm_volume: AlarmHelpers.normalizeSelectValue(defaults.alarm_volume, 0, 100, 5, defaults.alarm_volume),
    alarm_station_uri: this._normalizeStationValue(defaults.alarm_station_uri),
    monday: this._normalizeBooleanValue(defaults.monday),
    tuesday: this._normalizeBooleanValue(defaults.tuesday),
    wednesday: this._normalizeBooleanValue(defaults.wednesday),
    thursday: this._normalizeBooleanValue(defaults.thursday),
    friday: this._normalizeBooleanValue(defaults.friday),
    saturday: this._normalizeBooleanValue(defaults.saturday),
    sunday: this._normalizeBooleanValue(defaults.sunday)
  };

  if (!AlarmHelpers.findStationByUri(this.catalog, stored.alarm_station_uri)) {
    stored.alarm_station_uri = defaultStation;
  }

  return stored;
};

KoreanRadioAlarm.prototype.getBrowseList = function (uris) {
  return this.handleBrowseUri(uris);
};

module.exports = KoreanRadioAlarm;
