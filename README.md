# Rabbit Encoder

Automated AV1 video transcoding pipeline powered by **Auto-Boost-Essential** and **Opus** audio encoding, with a real-time web dashboard.

Drop media files into the `input` folder and get optimally encoded MKV files in the `output` folder.

## Features

- **Auto-Boost-Essential** integration for optimal per-scene CRF zones
- **Opus** audio encoding with configurable per-channel bitrates
- **HDR10 metadata** preservation (PQ, BT.2020, mastering display, content light)
- **Web dashboard** for monitoring progress and configuring per-file settings
- **File watcher** auto-detects new files in the input directory
- **Queue system** processes files sequentially

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
| `ENCODER_QUALITY`      | `medium`        | Default video quality (`low`, `medium`, `high`)                     |
| `ENCODER_SPEED`        | `slow`          | Default encode speed (`slower`, `slow`, `medium`, `fast`, `faster`) |
| `AUDIO_BITRATE_MONO`   | `64`            | Opus bitrate for mono audio (kbps)                                  |
| `AUDIO_BITRATE_STEREO` | `128`           | Opus bitrate for stereo audio (kbps)                                |
| `AUDIO_BITRATE_2_1`    | `160`           | Opus bitrate for 2.1 audio (kbps)                                   |
| `AUDIO_BITRATE_5_1`    | `256`           | Opus bitrate for 5.1 audio (kbps)                                   |
| `AUDIO_BITRATE_6_1`    | `320`           | Opus bitrate for 6.1 audio (kbps)                                   |
| `AUDIO_BITRATE_7_1`    | `384`           | Opus bitrate for 7.1 audio (kbps)                                   |
| `AUDIO_BITRATE_7_1_4`  | `512`           | Opus bitrate for 7.1.4 Atmos audio (kbps)                           |

## Web Dashboard

The dashboard at `http://localhost:3000` shows:

- **Job queue** with file info, status, and progress
- **Per-file settings** (quality, speed, audio bitrates) editable while queued
- **Live progress** tracking through all encoding stages
- **Results** showing output file size and encode time

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
{Title} - [Bluray-{Resolution}][Opus {Layout}][AV1]-RabbitCompany.mkv
```

## Supported Input Formats

`.mp4`, `.mkv`, `.avi`, `.webm`, `.flv`, `.ts`, `.mov`

## API Endpoints

| Method   | Endpoint              | Description                       |
| -------- | --------------------- | --------------------------------- |
| `GET`    | `/api/jobs`           | List all jobs                     |
| `GET`    | `/api/jobs/:id`       | Get job details                   |
| `PATCH`  | `/api/jobs/:id`       | Update job settings (queued only) |
| `DELETE` | `/api/jobs/:id`       | Remove a job                      |
| `POST`   | `/api/jobs/:id/retry` | Retry a failed job                |
| `GET`    | `/api/config`         | Get default settings              |
| `PATCH`  | `/api/config`         | Update settings                   |

## License

GPL-3.0
