'use strict';

var fs = require('fs-extra');
var path = require('path');
var libQ = require('kew');
var cron = require('node-cron');
var childProcess = require('child_process');
var VConf = require('v-conf');

var AlarmHelpers = require('./lib/alarm');

var PLUGIN_NAME = 'korean_radio_alarm';
var SOURCE_ID = 'korean_radio_alarm';
var SOURCE_URI = AlarmHelpers.SOURCE_URI || 'korean_radio_alarm://';
var STATION_URI_PREFIX = AlarmHelpers.STATION_URI_PREFIX || (SOURCE_URI + 'station/');
var BROWSE_SOURCE_NAME = 'Korean Radio Alarm';

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
  var lang = this.commandRouter && this.commandRouter.getLanguage ? this.commandRouter.getLanguage() : 'en';

  return safePromise(function () {
    if (!self.commandRouter || typeof self.commandRouter.i18nJson !== 'function') {
      return readJsonOrDefault(path.join(__dirname, 'UIConfig.json'), {});
    }

    var requested = path.join(__dirname, 'i18n', 'strings_' + lang + '.json');
    var fallback = path.join(__dirname, 'i18n', 'strings_en.json');
    return self.commandRouter.i18nJson(requested, fallback, path.join(__dirname, 'UIConfig.json'));
  }).then(function (uiConfig) {
    if (!uiConfig || !uiConfig.sections || !Array.isArray(uiConfig.sections) || !uiConfig.sections[0]) {
      return uiConfig;
    }

    var stationOptions = AlarmHelpers.stationOptionsFromCatalog(self.catalog);
    var alarmConfig = self._getStoredAlarmConfig();

    var section = uiConfig.sections[0];
    if (!Array.isArray(section.content)) {
      section.content = [];
    }

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

    if (contentById.alarm_enabled) {
      contentById.alarm_enabled.value = !!alarmConfig.alarm_enabled;
    }

    if (contentById.alarm_hour) {
      contentById.alarm_hour.value = hour;
      contentById.alarm_hour.options = [];
      for (var h = 0; h <= 23; h++) {
        contentById.alarm_hour.options.push({ value: h, label: toLabel(h, 2) });
      }
    }

    if (contentById.alarm_minute) {
      contentById.alarm_minute.value = minute;
      contentById.alarm_minute.options = [];
      for (var m = 0; m <= 55; m += 5) {
        contentById.alarm_minute.options.push({ value: m, label: toLabel(m, 2) });
      }
    }

    if (contentById.alarm_volume) {
      contentById.alarm_volume.value = volume;
      contentById.alarm_volume.options = [];
      for (var v = 0; v <= 100; v += 5) {
        contentById.alarm_volume.options.push({ value: v, label: String(v) });
      }
    }

    if (contentById.alarm_station_uri) {
      contentById.alarm_station_uri.value = stationUri;
      contentById.alarm_station_uri.options = stationOptions;
    }

    if (contentById.monday) {
      contentById.monday.value = !!alarmConfig.monday;
    }

    if (contentById.tuesday) {
      contentById.tuesday.value = !!alarmConfig.tuesday;
    }

    if (contentById.wednesday) {
      contentById.wednesday.value = !!alarmConfig.wednesday;
    }

    if (contentById.thursday) {
      contentById.thursday.value = !!alarmConfig.thursday;
    }

    if (contentById.friday) {
      contentById.friday.value = !!alarmConfig.friday;
    }

    if (contentById.saturday) {
      contentById.saturday.value = !!alarmConfig.saturday;
    }

    if (contentById.sunday) {
      contentById.sunday.value = !!alarmConfig.sunday;
    }

    return uiConfig;
  });
};

KoreanRadioAlarm.prototype.saveAlarm = function (data) {
  data = data || {};
  if (data.value && typeof data.value === 'object') {
    data = data.value;
  }

  var enabled = this._normalizeBooleanValue(data.alarm_enabled);
  var hour = AlarmHelpers.normalizeSelectValue(data.alarm_hour, 0, 23, 1, null);
  var minute = AlarmHelpers.normalizeSelectValue(data.alarm_minute, 0, 59, 5, null);
  var volume = AlarmHelpers.normalizeSelectValue(data.alarm_volume, 0, 100, 5, null);
  var stationUri = this._normalizeStationValue(data.alarm_station_uri);

  if (!AlarmHelpers.isValidTime(hour, minute) || volume === null) {
    var msg = this._t('ALARM.SAVE_ERROR', this._t('ALARM.SAVE_ERROR', 'Failed to save alarm settings'));
    this._pushToast('error', this._t('ALARM.TITLE', 'Korean Radio Alarm'), msg);
    return libQ.reject(new Error(msg));
  }

  var station = AlarmHelpers.findStationByUri(this.catalog, stationUri);
  if (!station) {
    var noStation = this._t('ALARM.NO_STATION', 'No valid station');
    this._pushToast('error', this._t('ALARM.TITLE', 'Korean Radio Alarm'), noStation);
    return libQ.reject(new Error(noStation));
  }

  this.configManager.set('alarm_enabled', !!enabled);
  this.configManager.set('alarm_hour', hour);
  this.configManager.set('alarm_minute', minute);
  this.configManager.set('alarm_station_uri', station.uri || stationUri);
  this.configManager.set('alarm_volume', volume);
  this.configManager.set('monday', !!data.monday);
  this.configManager.set('tuesday', !!data.tuesday);
  this.configManager.set('wednesday', !!data.wednesday);
  this.configManager.set('thursday', !!data.thursday);
  this.configManager.set('friday', !!data.friday);
  this.configManager.set('saturday', !!data.saturday);
  this.configManager.set('sunday', !!data.sunday);

  this.alarmConfig = this._getStoredAlarmConfig();
  this._rescheduleAlarm();
  this._pushToast('success', this._t('ALARM.TITLE', 'Korean Radio Alarm'), this._t('ALARM.SAVE_SUCCESS', 'Alarm saved'));

  return libQ.resolve({
    success: true,
    alarm: this.alarmConfig
  });
};

KoreanRadioAlarm.prototype.explodeUri = function (uri) {
  var station = AlarmHelpers.findStationByUri(this.catalog, uri);
  if (!station) {
    return libQ.reject(new Error('Invalid uri'));
  }

  var track = {
    service: PLUGIN_NAME,
    type: 'track',
    uri: station.uri || (STATION_URI_PREFIX + station.id),
    realUri: station.streamUrl,
    path: station.streamUrl,
    name: station.name,
    title: station.name
  };

  return libQ.resolve([track]);
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

  if (!playTrack.realUri) {
    if (typeof playTrack.uri === 'string') {
      playTrack.realUri = playTrack.uri;
    } else {
      return libQ.reject(new Error(this._t('ALARM.NO_URI', 'No track URI')));
    }
  }

  var self = this;
  var serviceName = 'mpd';

  return callPluginMethod(this.mpdPlugin, 'sendMpdCommand', ['stop', []])
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

        return callPluginMethod(self.commandRouter.stateMachine, 'syncState', [state, serviceName]);
      });
    });
};

KoreanRadioAlarm.prototype._onAlarmFire = function () {
  var self = this;
  if (!this.alarmConfig) {
    this.alarmConfig = this._getStoredAlarmConfig();
  }

  var station = AlarmHelpers.findStationByUri(this.catalog, this.alarmConfig.alarm_station_uri);
  if (!station) {
    this._pushToast('error', this._t('ALARM.TITLE', 'Korean Radio Alarm'), this._t('ALARM.NO_STATION', 'No valid station'));
    return libQ.resolve(false);
  }

  return this._setAlarmVolume(this.alarmConfig.alarm_volume)
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
  var lang = this.commandRouter && this.commandRouter.getLanguage ? this.commandRouter.getLanguage() : 'en';
  var requested = path.join(__dirname, 'i18n', 'strings_' + lang + '.json');
  var fallback = path.join(__dirname, 'i18n', 'strings_en.json');

  if (!this.commandRouter || typeof this.commandRouter.i18nJson !== 'function') {
    this.i18n = readJsonOrDefault(fallback, {});
    return libQ.resolve(this.i18n);
  }

  return safePromise(function () {
    return self.commandRouter.i18nJson(requested, fallback);
  }).then(function (json) {
    if (json && typeof json === 'object') {
      self.i18n = json;
    }

    return self.i18n;
  });
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

KoreanRadioAlarm.prototype._normalizeBooleanValue = function (value) {
  if (typeof value === 'object' && value !== null && value.value !== undefined) {
    value = value.value;
  }

  return !!value;
};

KoreanRadioAlarm.prototype._normalizeStationValue = function (value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    if (value.value) {
      return String(value.value);
    }
    return '';
  }

  return String(value);
};

KoreanRadioAlarm.prototype._rescheduleAlarm = function () {
  this._clearScheduledJobs();

  this.alarmConfig = this._getStoredAlarmConfig();
  if (!this.alarmConfig.alarm_enabled) {
    return;
  }

  var expressions = AlarmHelpers.buildCronExpressions(
    this.alarmConfig.alarm_hour,
    this.alarmConfig.alarm_minute,
    {
      monday: this.alarmConfig.monday,
      tuesday: this.alarmConfig.tuesday,
      wednesday: this.alarmConfig.wednesday,
      thursday: this.alarmConfig.thursday,
      friday: this.alarmConfig.friday,
      saturday: this.alarmConfig.saturday,
      sunday: this.alarmConfig.sunday
    }
  );

  var self = this;

  expressions.forEach(function (expr) {
    var task = cron.schedule(expr, function () {
      self._onAlarmFire();
    }, {
      timezone: self.timezone,
      scheduled: true
    });

    self.scheduledJobs.push(task);
  });
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
    return {
      service: PLUGIN_NAME,
      type: 'song',
      title: station.name,
      album: target.name || target.id,
      artist: target.name || target.id,
      icon: 'fa-broadcast-tower',
      uri: station.uri || (STATION_URI_PREFIX + station.id),
      path: station.streamUrl,
      realUri: station.streamUrl
    };
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

KoreanRadioAlarm.prototype._getStoredAlarmConfig = function () {
  var defaultStation = AlarmHelpers.firstStationUriFromCatalog(this.catalog) || '';
  var stored = {
    alarm_enabled: this.configManager.get('alarm_enabled', false),
    alarm_hour: this.configManager.get('alarm_hour', 7),
    alarm_minute: this.configManager.get('alarm_minute', 0),
    alarm_station_uri: this.configManager.get('alarm_station_uri', defaultStation),
    alarm_volume: this.configManager.get('alarm_volume', 45),
    monday: this.configManager.get('monday', true),
    tuesday: this.configManager.get('tuesday', true),
    wednesday: this.configManager.get('wednesday', true),
    thursday: this.configManager.get('thursday', true),
    friday: this.configManager.get('friday', true),
    saturday: this.configManager.get('saturday', false),
    sunday: this.configManager.get('sunday', false)
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
