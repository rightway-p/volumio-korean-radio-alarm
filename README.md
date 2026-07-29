# Korean Radio Alarm

A Volumio 4 Bookworm music service plugin that adds Korean radio browsing plus a weekly alarm scheduler.

## Features

- Browse grouped Korean radio stations in the Volumio browse section.
- Configure up to three independent alarm slots.
- Each slot supports own time, station, volume, and weekday schedule.
- Volumio 4 Bookworm compatibility (`engines.node >= 20`, `volumio >= 4`, `os: ["bookworm"]`).
- No additional system dependencies and no runtime writes to `/volumio` or `/myvolumio`.

## Included stations

- KBS
  - KBS Classic FM
  - KBS Cool FM
  - KBS Hanminjok
  - KBS World Radio
- News
  - YTN Radio
- Music
  - CBS Music FM

`MBC`, `SBS`, and `Listen.moe K-pop` are currently omitted because stream stability and playback compatibility need additional validation before re-adding.

## Default config for 3 alarm slots

`config.json` ships with defaults for `alarm_1`, `alarm_2`, and `alarm_3`.

- `alarm_1`: enabled=false, weekdays Mon-Fri=true, Sat/Sun=false
- `alarm_2`, `alarm_3`: enabled=false, all weekdays=false
- all slots use `korean_radio_alarm://station/kbs-classic-fm` as default station

Legacy single-slot config keys are still supported for migration.

## Install / test / uninstall (local repo)

```bash
cd /path/to/korean_radio_alarm
npm ci
npm test
```

You can install directly from the plugin folder on a Bookworm device:

```bash
# from device/remote shell
cd /path/to/korean_radio_alarm
volumio plugin install .
```

## Volumio submission checklist

- Use only repository defaults for Bookworm submission (`bookworm`, amd64/armhf, node>=20).
- Keep plugin entrypoints (`install.sh`, `uninstall.sh`, `config.json`, `UIConfig.json`) and lockfiles committed.
- Avoid external apt packages and avoid writing outside plugin-scoped directories.
- Verify no system-level side effects.
- Validate station catalogue and defaults align with submit-ready constraints.

See full checklist in [`docs/submission-checklist.md`](docs/submission-checklist.md).

## Known limitations

- Radio stream endpoints can change without notice.
- This repo intentionally omits `MBC`, `SBS`, and `Listen.moe K-pop` until stream stability is revalidated.
- Dynamic endpoint failures should surface naturally and be reviewed before re-enabling stations.
