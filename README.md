# Rabbit Encoder

Automated AV1 video transcoding pipeline powered by **Auto-Boost-Essential** and **Opus** audio encoding, with a real-time web dashboard.

Drop media files into the `input` folder and get optimally encoded MKV files in the `output` folder, or browse your media library directly from the dashboard and encode entire series in-place.

## Features

- **Auto-Boost-Essential** integration for optimal per-scene CRF zones
- **Opus** audio encoding with configurable per-channel bitrates
- **HDR10 metadata** preservation (PQ, BT.2020, mastering display, content light)
- **Web dashboard** for monitoring progress and configuring per-file settings
- **File watcher** auto-detects new files in the input directory
- **Queue system** processes files sequentially
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

All settings are configurable via environment variables in `docker-compose.yml`:

| Variable               | Default         | Description                                                         |
| ---------------------- | --------------- | ------------------------------------------------------------------- |
| `PORT`                 | `3000`          | Web dashboard port                                                  |
| `PASSWORD`             | `rabbitencoder` | Password to access web dashboard                                    |
| `FILE_COOLDOWN`        | `30`            | Seconds the file size must stay unchanged before encoding starts    |
| `ENCODER_QUALITY`      | `medium`        | Default video quality (`low`, `medium`, `high`)                     |
| `ENCODER_SPEED`        | `slow`          | Default encode speed (`slower`, `slow`, `medium`, `fast`, `faster`) |
| `AUDIO_BITRATE_MONO`   | `64`            | Opus bitrate for mono audio (kbps)                                  |
| `AUDIO_BITRATE_STEREO` | `128`           | Opus bitrate for stereo audio (kbps)                                |
| `AUDIO_BITRATE_2_1`    | `160`           | Opus bitrate for 2.1 audio (kbps)                                   |
| `AUDIO_BITRATE_5_1`    | `256`           | Opus bitrate for 5.1 audio (kbps)                                   |
| `AUDIO_BITRATE_6_1`    | `320`           | Opus bitrate for 6.1 audio (kbps)                                   |
| `AUDIO_BITRATE_7_1`    | `384`           | Opus bitrate for 7.1 audio (kbps)                                   |
| `AUDIO_BITRATE_7_1_4`  | `512`           | Opus bitrate for 7.1.4 Atmos audio (kbps)                           |
| `ORGANIZATION`         | `RabbitCompany` | Organization tag in output filenames                                |
| `INPUT_DIR`            | `/data/input`   | Directory to watch for new media files                              |
| `OUTPUT_DIR`           | `/data/output`  | Directory for encoded output files                                  |
| `TEMP_DIR`             | `/data/temp`    | Temporary working directory for encoding                            |
| `LIBRARY_DIRS`         | _(empty)_       | Comma-separated paths to media library folders (see below)          |

## Web Dashboard

The dashboard at `http://localhost:3000` shows:

- **Job queue** with file info, status, and progress
- **Per-file settings** (quality, speed, audio bitrates) editable while queued
- **Live progress** tracking through all encoding stages
- **Results** showing output file size and encode time
- **Library browser** for navigating and encoding mounted media folders

## Library Encoding

Library encoding lets you browse your media folders directly from the dashboard and encode entire series or movie collections in-place. This is designed for use with **Sonarr**, **Radarr**, and **Jellyfin**. You can download remuxes through Sonarr, then select the series folder in Rabbit Encoder to re-encode everything.

### How it works

1. Mount your media folders into the container as volumes
2. Set `LIBRARY_DIRS` to point to those mounted paths
3. Click **Library** in the dashboard header to browse your folders
4. Navigate into a series folder (e.g. `Blue Exorcist (2011)`) and click **Encode Folder**
5. All video files in the folder (and subfolders like Season 01, Season 02, Specials) are queued for encoding

### What happens when a library file is encoded

- The encoded file is placed **in the same directory** as the source file
- The **original source file is deleted**
- Associated **`.nfo` and thumbnail files** (`.jpg`, `.png`) matching the source filename are removed so Jellyfin regenerates fresh metadata
- Files that are **already encoded** (filename ends with `-{ORGANIZATION}.mkv`) are automatically skipped

### Example setup

```yaml
services:
  rabbit-encoder:
    image: rabbitcompany/rabbit-encoder:latest
    volumes:
      - ./input:/data/input
      - ./output:/data/output
      - ./temp:/data/temp
      - /mnt/HDD/media/Animes:/Animes
      - /mnt/HDD/media/Shows:/Shows
      - /mnt/HDD/media/Movies:/Movies
    environment:
      - LIBRARY_DIRS=/Animes,/Shows,/Movies
```

### Already-encoded detection

The encoder recognizes files it has already processed by checking the filename suffix. If `ORGANIZATION` is set to `RabbitCompany` (the default), then any file ending with `-RabbitCompany.mkv` is treated as already encoded and will be:

- Shown with a green **encoded** badge and dimmed in the library browser
- Completely **skipped** when you click Encode Folder

This means you can safely run Encode Folder on the same series multiple times (only new or unencoded files will be queued).

## Encoding Pipeline

For each file, the engine runs:

1. **Probe** - Extract media info (resolution, audio layout, HDR metadata)
2. **Prepare** - Extract the best video stream into a clean container
3. **Auto-Boost-Essential** - 4-stage video encoding:
   - Fast pass for scene analysis
   - Quality metric calculation (XPSNR)
   - Optimal CRF zone generation
   - Final encode with per-scene CRF adjustments
4. **Audio** - Encode audio tracks to Opus via FLAC pipe
5. **Mux** - Merge video + audio into MKV with metadata tags
6. **HDR** - Apply HDR10 metadata via mkvpropedit (if source is HDR)

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

## Supported Input Formats

`.mp4`, `.mkv`, `.avi`, `.webm`, `.flv`, `.ts`, `.mov`

## API Endpoints

| Method   | Endpoint              | Description                                            |
| -------- | --------------------- | ------------------------------------------------------ |
| `GET`    | `/api/jobs`           | List all jobs                                          |
| `GET`    | `/api/jobs/:id`       | Get job details                                        |
| `PATCH`  | `/api/jobs/:id`       | Update job settings (queued only)                      |
| `DELETE` | `/api/jobs/:id`       | Remove a job                                           |
| `POST`   | `/api/jobs/:id/retry` | Retry a failed job                                     |
| `GET`    | `/api/config`         | Get default settings                                   |
| `PATCH`  | `/api/config`         | Update default settings                                |
| `GET`    | `/api/library`        | List configured library root directories               |
| `GET`    | `/api/library/browse` | Browse a library folder (`?path=/data/library/Animes`) |
| `POST`   | `/api/library/encode` | Queue all videos in a folder for in-place encoding     |

All API endpoints require authentication via `Authorization: Bearer <token>` header, where the token is the BLAKE2b-512 hash of `rabbitencoder-{PASSWORD}`.

## License

GPL-3.0
