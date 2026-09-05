# Rabbit Encoder

Automated AV1 video transcoding pipeline powered by **Auto-Boost-Essential** and **Opus** audio encoding, with a real-time web dashboard.

Drop media files into the `input` folder and get optimally encoded MKV files in the `output` folder, or browse your media library directly from the dashboard and encode entire series in-place.

## Features

- **Auto-Boost-Essential** integration for optimal per-scene CRF zones
- **Opus** audio encoding with configurable per-channel bitrates
- **HDR10 metadata** preservation (PQ, BT.2020, mastering display, content light)
- **VapourSynth filter chain** stackable per-job filters (FineDehalo, DehaloAlpha...) with `light` / `medium` / `heavy` presets, full per-parameter overrides, and a hot-reloadable user preset directory for dropping in your own `.vpy` scripts
- **Web dashboard** for monitoring progress and configuring per-file settings
- **File watcher** auto-detects new files in the input directory
- **Queue system** processes files sequentially, with drag-and-drop reordering and pause/resume
- **Preview encoding** generates configurable short samples spread across the source, with frame-aligned source/encode comparisons before committing the full job
- **Library encoding** browse mounted media folders from the UI and encode in-place, replacing source files
- **Jellyfin / Sonarr integration** automatically cleans up `.nfo` and thumbnail files when replacing sources so metadata is regenerated
- **Smart skip** already-encoded files (detected by `-{ORGANIZATION}` suffix) are recognized and skipped

## Quick Start

```bash
# 1. Configure settings in docker-compose.yml (or use defaults)

# 2. deploy container
docker compose up -d

# 3. Open the dashboard (http://localhost:3000)

# 4. Drop files into the input folder
cp movie.mkv input/
```

## Configuration

Settings are configurable via environment variables in `docker-compose.yml`:

| Variable               | Default                       | Description                                                      |
| ---------------------- | ----------------------------- | ---------------------------------------------------------------- |
| `PORT`                 | `3000`                        | Web dashboard port                                               |
| `PASSWORD`             | `rabbitencoder`               | Password to access web dashboard                                 |
| `FILE_COOLDOWN`        | `30`                          | Seconds the file size must stay unchanged before encoding starts |
| `ORGANIZATION`         | `RabbitCompany`               | Tag appended to encoded filenames (e.g. `-RabbitCompany`)        |
| `INPUT_DIR`            | `/data/input`                 | Watched input directory                                          |
| `OUTPUT_DIR`           | `/data/output`                | Encoded output directory                                         |
| `TEMP_DIR`             | `/data/temp`                  | Temporary encode and preview files                               |
| `LIBRARY_DIRS`         | empty                         | Comma-separated mounted library roots                            |
| `FONTS_STOCK_DIR`      | `/app/fonts`                  | Seed font groups copied into the user dir on first start         |
| `FONTS_USER_DIR`       | `/config/fonts`               | User font groups (read/write; the only directory scanned)        |
| `SYSTEM_FONTS_DIRS`    | `/system-fonts`               | Read-only host font dirs, browsable to import fonts into groups  |
| `VS_PRESETS_STOCK_DIR` | `/app/vapoursynth/presets`    | Built-in VapourSynth preset directory                            |
| `VS_PRESETS_USER_DIR`  | `/config/vapoursynth/presets` | User VapourSynth preset directory                                |
| `VS_RABBIT_MODULE_DIR` | `/app/vapoursynth`            | Rabbit Encoder VapourSynth helper-module directory               |

If `ORGANIZATION` is set to `RabbitCompany` (the default), then any file ending with `-RabbitCompany.mkv` is treated as already encoded and will be:

- Shown with a green **encoded** badge and dimmed in the library browser
- Completely **skipped** when you click Encode Folder

This means you can safely run Encode Folder on the same series multiple times (only new or unencoded files will be queued).

## Encoding Pipeline

For each file, the engine runs:

1. **Probe** - Extract media information such as resolution, audio layout, frame rate, subtitle tracks, and HDR metadata.
2. **Prepare** - Extract the primary video stream, run the configured VapourSynth passes, and apply the FFmpeg crop/downscale/denoise/deband chain.
3. **Auto-Boost-Essential** - Run scene analysis, quality metrics, CRF-zone generation, and the final AV1 encode.
4. **Audio** - Sort, filter, deduplicate, and encode selected audio tracks to Opus through a FLAC pipe, or copy them when configured.
5. **Subtitles and fonts**
   - Sort, filter, deduplicate, and rename subtitle tracks.
   - Optionally convert SRT subtitles to ASS.
   - Restyle dialogue-classified ASS styles without changing signs, songs, or other untouched styles.
   - Resolve language/script-specific font faces.
   - Instance selected variable-font axes into static font files.
   - Remove unused source font attachments when enabled.
   - Preserve source fonts still referenced by surviving untouched styles or inline `\fn` overrides.
   - Use numbered aliases such as `Noto Sans 2` only when a retained source font already occupies the requested family name.
6. **Mux** - Merge video, audio, subtitles, chapters, fonts, and metadata into the final MKV.
7. **HDR** - Apply HDR10 metadata with `mkvpropedit` when required.

## Preview Encoding

Preview encoding creates configurable samples distributed across the source so source and encoded results can be compared before running the full job.

Each sample starts from an exact, lossless FFV1 video window rather than a stream-copied GOP fragment. This prevents keyframe preroll and timestamp offsets from causing source and encoded comparison images to land on different frames. The default is 6 samples, and both the sample count and duration can be changed through the dashboard or preview API.

Intermediate VapourSynth and prepare-filter stills are also exposed when those stages are active.

## VapourSynth Filters

Rabbit Encoder ships with a VapourSynth filter system that lets you stack arbitrary preprocessing passes in front of the main encode. Each filter runs as its own `vspipe` pass.

### Stock presets

Built-in presets live under `/app/vapoursynth/presets` inside the container and are namespaced as `stock:<id>`:

| Preset ID            | Name         | Description                                                                                                                                        |
| -------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stock:finedehalo`   | FineDehalo   | Reduces dark/bright halos around high-contrast edges. Best for anime and DVD upscales.                                                             |
| `stock:dehalo_alpha` | Dehalo Alpha | Classic halo reduction via `vs-jetpack`'s `dehalo_alpha`.                                                                                          |
| `stock:f3k_deband`   | F3K Deband   | Removes color banding in smooth gradients while preserving detail. Wraps `vszip.Deband` (modern f3kdb successor) and can re-grain after debanding. |

Every preset declares its own `levels` (typically `light`, `medium`, `heavy`) and a set of tunable parameters. You can pick a level per job and override individual params per-level in the dashboard's **Advanced Settings -> VapourSynth Filters** panel.

### User custom presets

To add your own filter, drop a matching pair of files into the host-mounted user directory (`./vapoursynth-user/presets` by default, exposed inside the container at `/config/vapoursynth/presets`):

```
myfilter.vpy    # the VapourSynth script
myfilter.json   # the manifest (id, levels, params, defaults)
```

Both files must share the same stem. The `.vpy` script reads its input path from the `SRC` argument and any tunable parameter via `rabbit_vs.arg_int / arg_float / arg_str / arg_bool`. See [**Examples**](https://github.com/Rabbit-Company/RabbitEncoder/tree/main/vapoursynth/presets).

User presets are namespaced as `user:<id>` and override nothing (stock and user presets coexist). After editing or adding presets, click **Reload presets** in the Advanced Settings panel (or `POST /api/vs-presets/reload`); no container restart is required.

### Per-job behavior

The VapourSynth chain is stored per job, so different files in the same queue can use different filter stacks. Each entry has a `level` (or `"off"` to disable without removing it from the chain) and a per-level parameter map, letting you switch intensity without losing your tweaks at other levels. The active chain and its resolved parameters are stored in the output MKV's versioned `SETTINGS` code (for example, `RE1|...`) so the configuration can be reproduced later.

## Subtitle Fonts

Subtitles are styled per **font group**. A group is a folder under the user fonts
directory (`/config/fonts`) containing one or more font files plus an optional
`metadata.json`. A single group can supply different faces for different writing
systems. For example a Latin-only face like Trebuchet MS together with a CJK
face like Noto Sans JP - so one group can cover scripts no single font does.

`Noto Sans` and `Noto Serif` ship with Rabbit Encoder and are seeded into
`/config/fonts` on first start if they are not already present, so they are
editable in place.

### metadata.json

```jsonc
{
	"label": "Anime old",
	"faces": {
		"trebuchet.ttf": { "keys": ["latin"] },
		"noto_jp.ttf": { "keys": ["japanese", "jpn"] },
	},
	"style": {
		// group-global appearance (1080p px)
		"fontSize": 80,
		"outline": 4,
		"shadow": 1.5,
		"marginV": 50,
		"marginL": 135,
		"marginR": 135,
		"alignment": 2,
		"bold": false,
		"primaryColour": "&H00FFFFFF",
		"outlineColour": "&H00000000",
		"backColour": "&H80000000",
	},
	"overrides": {
		"jpn": { "fontSize": 72, "marginV": 60, "fontAxes": { "wght": 600 } },
		"japanese": { "fontSize": 74 },
		"latin": { "fontAxes": {} },
	},
}
```

For each subtitle track, the face and the appearance are both resolved by the
track's language tag and the detected writing system, in this order:

1. a `keys`/`overrides` entry matching the **language code** (e.g. `jpn`, `de`),
2. then the **writing system** (e.g. `latin`, `japanese`, `cjk`),
3. then the group-global `style`,
4. then the built-in defaults.

The family name written into the ASS is taken from the resolved face, so
`style`/`overrides` only carry appearance (size, outline, shadow, margins,
colours, alignment, bold, and variable-font axes). Because axes are face-specific,
they belong in the per-key override for that face (a static Latin face has none;
a variable CJK face can pin `wght`).

You can manage font groups entirely from the dashboard ("Manage font groups..."):
create, rename, and delete groups, edit each face's `keys`, and remove faces. All
changes are written to `/config/fonts` and the registry is reloaded automatically.
Renaming a group also repoints the `fontGroup` reference in your default settings
and in every queued job, so existing selections aren't orphaned.

If you mount a host font directory read-only, those
fonts become selectable in the import dropdown: pick a font, choose a writing
system (Latin, Japanese, Cyrillic, ...) or type extra language keys, and click
**Import** to copy it into the selected group with those `keys`. The host mount is
never written to - import always copies into `/config/fonts`.

You can still edit a group's style from the dashboard ("Subtitle font & style..."),
choosing a scope of "Group global" or a specific script/language; saving writes
back to the group's `metadata.json`. Click **Reload fonts** (or
`POST /api/fonts/reload`) after hand-editing files on disk.

Variable-font axes are instanced into static fonts before attachment. When a
retained source font already uses the selected internal family name, Rabbit
Encoder picks the first free numbered alias (`Noto Sans` → `Noto Sans 2` →
`Noto Sans 3`), written consistently into the static font's internal metadata and
the ASS styles it rewrites. The attachment **filename** is slugified
(`Noto Sans 2` -> `noto_sans_2.ttf`); the internal family name keeps its spaces,
so rendering is unaffected.

With **Remove unused fonts** enabled, source attachments are kept only when
surviving untouched ASS styles or inline `\fn` overrides still reference them.

## Output Naming

Files are named following the pattern:

```
{Title} [Source-Resolution][Opus Layout][AV1]-{ORGANIZATION}.mkv
```

For example:

```
Blue Exorcist (2011) - S01E01 - The Devil Resides in Human Souls [Bluray-1080p][Opus 2.0][AV1]-RabbitCompany.mkv
```

Source tags are detected from the input filename: `Bluray`, `WEBDL`, `WEBRip`, `HDTV`, `DVD`, `SDTV`, `CAM`. Files with `REMUX` in the name are tagged as `Bluray`.

## Settings Codes

Each encoded file includes a `SETTINGS` tag. This is a compact, versioned string that records the exact resolved settings used for the encode, such as `RE1|c~q=h,ds=1|dn~m=m,s=4.5,p=5,r=13`.

The settings code stores the actual underlying values, including every nlmeans and gradfun parameter, each active VapourSynth filter in chain order, and all related filter parameters. This makes it possible to reproduce a setup even if presets have changed since the original encode.

To restore settings from a code, paste it into the **Settings Code** field in either the Default Settings panel or the per-job settings panel. Codes are portable across machines because GPU-specific choices, such as the denoise backend and GPU device, are intentionally left out. This prevents an imported code from overwriting the target machine’s hardware configuration.

The format is versioned with an `RE<n>` prefix, so older codes continue to work as the format evolves. Fields that match the shipped baseline are omitted, which means a stock-default configuration is represented simply as `RE1`.

## Supported Input Formats

`.mp4`, `.mkv`, `.avi`, `.webm`, `.flv`, `.ts`, `.mov`

## API Endpoints

| Method   | Endpoint                                    | Description                                                                    |
| -------- | ------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET`    | `/api/jobs`                                 | List all jobs                                                                  |
| `GET`    | `/api/jobs/:id`                             | Get job details                                                                |
| `PATCH`  | `/api/jobs/:id`                             | Update job settings (queued only)                                              |
| `DELETE` | `/api/jobs/:id`                             | Remove a job                                                                   |
| `POST`   | `/api/jobs/:id/retry`                       | Retry a failed job                                                             |
| `POST`   | `/api/jobs/:id/cancel`                      | Cancel an actively encoding job                                                |
| `POST`   | `/api/jobs/:id/move`                        | Move a queued job in the queue (`direction`: `up`, `down`, `top`, `bottom`)    |
| `POST`   | `/api/jobs/:id/import-code`                 | Apply a settings code to a queued job, replacing its settings                  |
| `POST`   | `/api/jobs/reorder`                         | Set the entire queue order from a JSON `{ ids: [...] }` body                   |
| `GET`    | `/api/jobs/:id/audio-preview`               | Preview audio reorder/filter/dedup for a job                                   |
| `GET`    | `/api/jobs/:id/subtitle-preview`            | Preview subtitle reorder/rename for a job                                      |
| `GET`    | `/api/jobs/:id/subtitle-tracks`             | List source subtitle tracks (for the translate-only source picker)             |
| `GET`    | `/api/jobs/:id/mediainfo`                   | Run `mediainfo` on the source file and return the report                       |
| `GET`    | `/api/jobs/:id/bitrate-analysis`            | Bitrate + noise/bitrate-metric scene data, cached (`?refresh=1` to re-run)     |
| `GET`    | `/api/jobs/:id/preview`                     | Get preview-encode state for a job (`idle`, running, or completed samples)     |
| `POST`   | `/api/jobs/:id/preview`                     | Start a preview encode; optional body configures sample count and duration     |
| `DELETE` | `/api/jobs/:id/preview`                     | Cancel a running preview, or clear completed preview artifacts                 |
| `GET`    | `/api/jobs/:id/preview/sample/:index/:kind` | Fetch source/encode clips, comparison PNGs, VS stills, or prepare-stage stills |
| `GET`    | `/api/config`                               | Get default settings                                                           |
| `PATCH`  | `/api/config`                               | Update default settings                                                        |
| `POST`   | `/api/config/reset`                         | Reset default settings                                                         |
| `POST`   | `/api/config/import-code`                   | Import a settings code as the new default settings                             |
| `POST`   | `/api/settings/encode`                      | Encode a settings object into a shareable settings code (`{ code }`)           |
| `POST`   | `/api/settings/decode`                      | Decode a settings code back into a settings object (`{ settings }`)            |
| `GET`    | `/api/library`                              | List configured library root directories                                       |
| `GET`    | `/api/library/browse`                       | Browse a library folder (`?path=/data/library/Animes`)                         |
| `POST`   | `/api/library/encode`                       | Queue all videos in a folder for in-place encoding                             |
| `GET`    | `/api/queue`                                | Get queue state (paused or running)                                            |
| `POST`   | `/api/queue/pause`                          | Pause encoding - stops current encode, preserves queue                         |
| `POST`   | `/api/queue/resume`                         | Resume encoding from where it was paused                                       |
| `GET`    | `/api/fonts`                                | List font groups and their faces                                               |
| `POST`   | `/api/fonts/reload`                         | Rescan the user fonts directory and reload the registry                        |
| `GET`    | `/api/fonts/:label/style`                   | Get a group's style (group-global + per-language/script overrides)             |
| `PUT`    | `/api/fonts/:label/style`                   | Save a group's style into its `metadata.json` (user fonts dir)                 |
| `PUT`    | `/api/fonts/:label/style`                   | Save a group's style into its `metadata.json` (user fonts dir)                 |
| `GET`    | `/api/system-fonts`                         | List importable fonts under the read-only host font directories                |
| `POST`   | `/api/fonts/groups`                         | Create a new font group folder under the user fonts dir (`{ label }`)          |
| `PATCH`  | `/api/fonts/groups/:label`                  | Rename a group (folder + label) and repoint defaults and all jobs              |
| `DELETE` | `/api/fonts/groups/:label`                  | Delete a font group folder and its contents                                    |
| `POST`   | `/api/fonts/groups/:label/faces`            | Import a host font into the group with writing-system / language keys          |
| `PATCH`  | `/api/fonts/groups/:label/faces/:file`      | Update a face's keys / family override in the group's `metadata.json`          |
| `DELETE` | `/api/fonts/groups/:label/faces/:file`      | Remove a font file from the group and its metadata entry                       |
| `GET`    | `/api/system`                               | Current system resource usage (CPU, RAM, temp-partition disk, network, GPU)    |
| `GET`    | `/api/opencl-devices`                       | List available OpenCL devices                                                  |
| `GET`    | `/api/vulkan-devices`                       | List available Vulkan devices                                                  |
| `GET`    | `/api/benchmark`                            | Get current benchmark state                                                    |
| `POST`   | `/api/benchmark`                            | Start a denoise benchmark run                                                  |
| `DELETE` | `/api/benchmark`                            | Cancel a running benchmark                                                     |
| `GET`    | `/api/vs-presets`                           | List all VapourSynth presets (stock + user) with their manifests               |
| `POST`   | `/api/vs-presets/reload`                    | Rescan stock and user preset directories from disk and reload the registry     |
| `GET`    | `/api/vs-presets/:id/default-entry`         | Build a fresh filter-chain entry for `:id`, pre-filled with manifest defaults  |

## License

GPL-3.0
