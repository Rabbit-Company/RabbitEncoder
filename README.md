# Rabbit Encoder

Automated AV1 video transcoding pipeline powered by **Auto-Boost-Essential** and **Opus** audio encoding, with a real-time web dashboard.

Drop media files into the `input` folder and get optimally encoded MKV files in the `output` folder, or browse your media library directly from the dashboard and encode entire series in-place.

## Features

- **Auto-Boost-Essential** integration for optimal per-scene CRF zones
- **Opus** audio encoding with configurable per-channel bitrates
- **HDR10 metadata** preservation (PQ, BT.2020, mastering display, content light)
- **HDR10+ metadata** measured for every PQ source with [retone](https://github.com/Rabbit-Company/retone) and written into the AV1 encode, with the scenes of a Dolby Vision source's shots
- **HDR Metadata tool** to inspect, add, measure, import, change and remove HDR10+, HDR10 and Dolby Vision metadata in existing AV1 MKVs, one file or a whole folder, without re-encoding
- **Film Grain tool** to inspect, add, replace and remove AV1 film grain synthesis in existing AV1 MKVs, one file or a whole folder, without re-encoding
- **VapourSynth filter chain** stackable per-job filters (FineDehalo, DehaloAlpha...) with `light` / `medium` / `heavy` presets, full per-parameter overrides, and a hot-reloadable user preset directory for dropping in your own `.vpy` scripts
- **Web dashboard** for monitoring progress and configuring per-file settings
- **File watcher** auto-detects new files in the input directory
- **Queue system** processes files sequentially, prioritizes quick repair jobs over pending encodes, and supports reordering plus pause/resume
- **Preview encoding** generates configurable short samples spread across the source, with frame-aligned source/encode comparisons before committing the full job
- **Library encoding** browse mounted media folders from the UI and encode in-place, replacing source files
- **Subtitle repair/remux** replace, remove, reorder, retag, restyle, or recompress MKV subtitle tracks without re-encoding video or audio
- **Subtitle editor** browse MKVs, navigate and edit SRT/ASS/SSA cues, and preview timing changes in an audible video loop (three seconds before and after each cue by default). Adjust track offsets and loop boundaries. Bitmap PGS/VobSub/DVB subtitles use track delays. Save a separate `*.subtitles-edited.mkv` with video and audio copied unchanged.
- **Folder metadata audit** group MKVs by their ordered audio/subtitle metadata, edit subtitle metadata across an entire group, highlight missing or inconsistent tracks, and open outliers against the majority layout in the Rabbit repair editor
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
| `RECYCLE_BIN_DIR`      | empty                         | Keep originals of in-place library encodes here (see below)      |
| `FONTS_STOCK_DIR`      | `/app/fonts`                  | Seed font groups copied into the user dir on first start         |
| `FONTS_USER_DIR`       | `/config/fonts`               | User font groups (read/write, the only directory scanned)        |
| `SYSTEM_FONTS_DIRS`    | `/system-fonts`               | Read-only host font dirs, browsable to import fonts into groups  |
| `VS_PRESETS_STOCK_DIR` | `/app/vapoursynth/presets`    | Built-in VapourSynth preset directory                            |
| `VS_PRESETS_USER_DIR`  | `/config/vapoursynth/presets` | User VapourSynth preset directory                                |
| `VS_RABBIT_MODULE_DIR` | `/app/vapoursynth`            | Rabbit Encoder VapourSynth helper-module directory               |

If `ORGANIZATION` is set to `RabbitCompany` (the default), then any file ending with `-RabbitCompany.mkv` is treated as already encoded and will be:

- Shown with a green **encoded** badge and dimmed in the library browser
- Completely **skipped** when you click Encode Folder

This means you can safely run Encode Folder on the same series multiple times (only new or unencoded files will be queued).

The Library browser skips recursive folder counts by default, so opening folders on network storage stays fast. It still shows sizes and encoded badges for video files in the open folder. Turn on **Show folder counts and encoded status** in the Library window to scan subfolders and show video totals and green badges for fully encoded folders. This choice is saved in your browser. Encoding still skips files that are already encoded when counts are off.

If `RECYCLE_BIN_DIR` is set, the original of every library file that is replaced in place is moved into that directory instead of being overwritten or deleted, keeping its full path:

```
Library:      /Animes/example/series/Episode 1.mkv
Recycle bin:  <RECYCLE_BIN_DIR>/Animes/example/series/Episode 1.mkv
```

The recycle bin is never emptied automatically, so delete the originals yourself once you have checked the encodes. Mount it on the same filesystem as your library to make the move instant as otherwise the original is copied. Keep it outside `LIBRARY_DIRS`.

## Encoding Pipeline

For each file, the engine runs:

1. **Probe:** Extract media information such as resolution, audio layout, frame rate, subtitle tracks, and HDR metadata.
2. **Prepare:** Extract the primary video stream, run the configured VapourSynth passes, and apply the FFmpeg crop/downscale/denoise/deband chain.
3. **HDR10+:** For PQ sources, measure HDR10+ metadata of the prepared video with retone.
4. **Auto-Boost-Essential:** Run scene analysis, quality metrics, CRF-zone generation, and the final AV1 encode, then write the HDR10+ metadata and film grain into it.
5. **Audio:** Sort, filter, deduplicate, and encode selected audio tracks to Opus through a FLAC pipe, or copy them when configured.
6. **Subtitles and fonts**
   - Sort, filter, deduplicate, and rename subtitle tracks.
   - Optionally convert SRT subtitles to ASS.
   - Restyle dialogue-classified ASS styles without changing signs, songs, or other untouched styles.
   - Resolve language/script-specific font faces.
   - Instance selected variable-font axes into static font files.
   - Remove unused source font attachments when enabled.
   - Preserve source fonts still referenced by surviving untouched styles or inline `\fn` overrides.
   - Use numbered aliases such as `Noto Sans 2` only when a retained source font already occupies the requested family name.
7. **Mux:** Merge video, audio, subtitles, chapters, fonts, and metadata into the final MKV.
8. **HDR:** Apply HDR10 metadata with `mkvpropedit` when required.

## Preview Encoding

Preview encoding creates configurable samples distributed across the source so source and encoded results can be compared before running the full job.

Each sample starts from an exact, lossless FFV1 video window rather than a stream-copied GOP fragment. This prevents keyframe preroll and timestamp offsets from causing source and encoded comparison images to land on different frames. The default is 6 samples, and both the sample count and duration can be changed through the dashboard or preview API.

Intermediate VapourSynth and prepare-filter stills are also exposed when those stages are active.

### Film grain tables

Rabbit measures film grain with [regrain](https://github.com/Rabbit-Company/regrain), which compares the grainy original with the denoised video and writes an AV1 film grain table with an entry for every scene.

When adding externally denoised videos from the Library, choose an original file or a folder of originals in **Queue Videos**. Rabbit proposes unique episode or filename matches. Review the pairs and adjust any unmatched rows. **Generate FGS tables automatically for mapped videos** is on by default when a match is found and can be turned off. Mapped originals are also preselected in Preview. Unmapped videos encode without automatic FGS. Each mapped video measures its table as a **Film Grain** step of its own encode, right after **Analyze**. regrain uses every CPU core, so the step never runs beside another job's denoise or encode. The step shows frame progress, speed, and ETA. If generation fails, the job fails with the error, and retrying the job retries generation. Starting a Preview for a mapped job measures the table first when it does not exist yet.

**Measurement range** controls which part of the video is measured. **Quick** is the default for new jobs: regrain measures a 30-second window near the middle of both videos, and Rabbit keeps its middle entry for the whole encode. Videos shorter than a minute use the full video. **Full video** measures the whole video, so every scene keeps its own grain. The resulting table is stored on the job and reused for every Preview and the final encode.

**Scan** controls how much of the measured range regrain reads. **Every frame** is the most accurate. **Half**, **Quarter** and **Eighth** read that share of every 48 frames and are faster, with a small loss of accuracy. On an 8 core laptop CPU, a full video measurement of a 24 minute episode took about 4 minutes with Every frame and under 2 minutes with Quarter. Both controls are available in **Queue Videos** and **Advanced Settings -> AV1 film grain table**. Changing them does not regenerate a table that already exists. Generate it again to use the new choices.

For an individual queued video, **Advanced Settings -> AV1 film grain table** can generate a table from its aligned grainy original, or accept an existing table path inside the encoder container. Generation runs right away and shows frame progress, speed, and ETA in that window. It can be cancelled, and it continues if the window is closed. Run it while no encode is active, because it uses every CPU core. The table is stored in the mounted temp directory. The original and denoised files must have the same constant frame rate and start on the same frame. regrain checks both and stops with an error when the videos have a variable frame rate or are off by a frame. When the denoised file was cropped first, Rabbit finds where its frame sits inside the original and lets regrain measure only that area. When the denoiser removed no measurable grain, the table is empty and the video is encoded without film grain. Run **Preview** before the full encode.

When Rabbit denoises the video itself, turn on **Advanced Settings -> AV1 film grain table -> Restore denoised grain**. No original has to be chosen. Rabbit keeps the video as it is right before the denoise pass and measures the grain the denoiser removed as a **Film Grain** step right after **Prepare**. The kept copy is a hard link, so it takes no extra space. Crop is passed to regrain as the measured area. With **Downscale** on, Rabbit first writes a scaled copy of that video, so both sides are measured at the encode resolution. Measurement range and Scan apply as above. The table is measured on every run and never stored on the job, so a changed denoise setting always gets a fresh table. A Preview measures each sample clip on its own. When auto denoise finds nothing to denoise, the step is skipped. A table from an original or a table path takes precedence over this setting.

**Amount -> Just enough to hide banding** puts back only as much of the measured grain as it takes to hide banding, at most a deviation of 0.5 on the 0 to 255 scale. It uses `regrain diff --just-enough` and applies to every measured table, both from an original and from Rabbit's own denoise.

**Pattern -> Static grain pattern** applies the table with `regrain apply --static-grain`. Every frame of a table entry uses the entry's seed, so the decoder lays the same grain pattern over the whole scene like a texture on the screen, instead of a new pattern each frame. It suits light grain on footage that mostly stands still, such as grain that only hides banding in anime. Where the camera pans, the pattern stays in place while the picture moves under it. The pattern changes where the next table entry starts. It applies to every table, also a synthetic one or a table path you enter yourself.

**Synthetic grain** writes grain of a chosen strength with `regrain generate` for jobs where no measured table applies, including jobs without any denoise. **Strength** is given as an **ISO** or as a **Deviation**, and 0 turns it off. **ISO** is the camera sensor noise of `regrain generate --iso`, the photon noise model of libaom that aomenc and SVT-AV1 use for `--photon-noise`, so the same ISO gives the same grain. Rabbit gives regrain the frame size of the encode, after the downscale to 1080p, and the whole 16:9 frame when black bars were cut, so a letterboxed film gets the grain of its frame. A smaller frame has larger pixels and less noise: at 1080p, ISO 200 to 600 gives a deviation of 0.38 to 0.50, about what hides banding in anime, and 4K needs a quarter of the ISO for the same grain. ISO grain is weaker in shadows and stronger in highlights, as a sensor's is. **Deviation** is the luma deviation on the 0 to 255 scale, 0.6 times as strong at black and 0.7 times at white as in the middle, as film grain is. Settings saved before ISO keep their deviation. **Fine** is single pixels like digital camera noise, **Medium** is like most film grain, and **Coarse** forms clumps a few pixels wide. **Chroma** adds color grain. With Restore denoised grain also on, synthetic grain is used when nothing was denoised or the denoiser removed no measurable grain.

After the video is encoded, Rabbit writes the table into the AV1 stream with `regrain apply`, for previews and full encodes. regrain then reads the result back, checks every frame's grain, and decodes it with dav1d before Rabbit continues. SVT-AV1's own `--fgs-table` reads only the first entry of a table, so it is not used. A **Full video** table is applied scene by scene, and each segment keeps the grain measured for it. A **Quick** table is applied as one segment to the whole video. A table path you enter yourself is applied as written, so its timestamps have to match the video. Keep the source table available until encoding finishes. Do not combine the table with `--photon-noise`, `--film-grain`, or `--fgs-table` in custom encoder parameters. Grain the encoder wrote itself is replaced by the table.

The container downloads the checksum-verified [regrain v0.3.2 release](https://github.com/Rabbit-Company/regrain/releases/tag/v0.3.2). It is a static binary that uses the container's FFmpeg.

### HDR10+ metadata

AV1 encoders cannot measure HDR10+ metadata, so a PQ source used to come out as plain HDR10 even when it had HDR10+ or Dolby Vision. With **HDR -> Write HDR10+ metadata**, which is on by default, Rabbit measures the metadata with [retone](https://github.com/Rabbit-Company/retone) as an **HDR10+** step after Prepare and writes it into the AV1 encode. HDR10+ displays then tone map every scene on its own instead of the whole video at once. The setting only acts on PQ sources encoded to AV1. HLG and SDR sources are encoded as before.

The step measures the video as it will be encoded, after crop, downscale and denoise, so the metadata describes the picture the display gets. Every scene gets one set of values, so a display does not change its tone mapping in the middle of a shot. When the source has Dolby Vision, the scenes follow the shots its colourist marked, read from the Dolby Vision metadata with `retone convert`. When that metadata does not fit the prepared video frame for frame, for example after dropped frames were filled, the scenes are measured instead and the log says so. A Preview measures each sample clip on its own.

After the final encode, `retone apply` writes one HDR10+ metadata OBU right before every shown frame, as the HDR10+ AV1 specification requires, and tags the video as BT.2020 PQ when the encoder left the tags out. When a film grain table follows, regrain's verification decodes the stream with the HDR10+ metadata in it. Otherwise retone reads the result back and decodes it with dav1d itself. When the source states no MaxCLL and MaxFALL, the values the measurement found are written into the MKV colour elements. The step shows the number of scenes and where they came from.

HDR10+ metadata is not worth failing an encode over. When measuring or writing it fails, the step says why, the log has a warning, and the encode finishes as HDR10. The settings code records `hp=0` when the setting is off.

The container downloads the checksum-verified [retone v0.1.3 release](https://github.com/Rabbit-Company/retone/releases/tag/v0.1.3). It is a static binary that uses the container's FFmpeg.

## Subtitle Repair / Remux

Open **Repair** in the dashboard, select an encoded MKV and optionally its original source MKV, then inspect their subtitle tracks. The output plan can keep or remove target tracks, import source tracks, reorder them, edit names/languages and Matroska flags, and choose `zlib`, uncompressed, or the track's current compression. Text tracks can either be copied unchanged or processed with the current Rabbit ASS/SRT styling defaults.

Repair jobs use MKVToolNix stream copying: video and audio codecs are verified before the result is accepted, and source/target duration mismatches are rejected. The single-file repair editor's **Save changes to** defaults to **Existing MKV file**. Choose **New .repaired.mkv copy** to write a non-colliding copy beside the encoded target instead. Replacement only happens atomically after the staged MKV passes verification.

Use **Audit folder** to inspect every MKV directly inside a selected folder. Files are grouped as A, B, C, and so on by their ordered audio/subtitle track type, language, title, and flags. Group A is the majority layout. Outliers list their exact differences and open directly in the repair editor. Audits launched from a completed queue folder also pair each encode with its own original input, making missing source subtitles available for plain copying or Rabbit ASS/SRT processing without ever borrowing subtitle content from another episode.

Choose **Edit group** beside a group to change subtitle names, languages, and flags for all of its files at once. Each subtitle row applies to the same ordered subtitle in every episode, using that episode's own track ID and preserving its compression. **Queue changes** validates the whole group against the audit before queueing one metadata repair per file. **Save changes to** defaults to **Existing MKV files**, updating each file after verification. Choose **New .repaired.mkv copies** if you prefer separate output files. Follow progress in the job list and audit again after completion to inspect the results.

## HDR Metadata

**Tools -> HDR Metadata** changes the HDR metadata of AV1 MKVs that already exist, for example encodes made before Rabbit wrote HDR10+, without re-encoding them. Choose **One file** to inspect a video first. Rabbit reads it with retone and shows its HDR formats, colour description, mastering display, MaxCLL and MaxFALL, how many frames carry HDR10+ metadata with its scenes and peak, whether it has Dolby Vision, and the problems `retone check` finds. Other videos, such as HEVC originals, are described but cannot be changed.

| Setting                   | Choices                                                                                                                                               |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HDR10+**                | Keep, measure it from the video, measure it with the scenes of a Dolby Vision original, import it from a JSON file or another AV1 video, or remove it |
| **Dolby Vision**          | Remove it, which leaves HDR10. Shown when the file has Dolby Vision                                                                                   |
| **HDR10 static metadata** | Keep, set the mastering display (BT.2020 or Display P3 with its luminance) with MaxCLL and MaxFALL taken from HDR10+ or entered, or remove it         |
| **Colour tags**           | Tag the video as BT.2020 PQ. Offered only for video without a transfer tag, since tagging SDR as PQ makes it look washed out                          |

Every change becomes a job in the queue with **Analyze**, **HDR10+** when measuring, **Write** and **Replace** steps. Rabbit extracts the AV1 track, writes the changes with retone, rebuilds the MKV with MKVToolNix from the new video and every other track, attachment, chapter and tag of the original, and gives the video track its name, language, flags, frame timestamps, default duration and colour elements back. The rebuilt file replaces the original only after its tracks, attachments, chapters, duration and timestamps are verified, so a failed job leaves the file as it was. Measuring decodes the whole video, the other changes take seconds.

An HDR10+ JSON file is uploaded from the browser and can be up to 512 MB, enough for a feature film. It must have one entry per frame of the video, as must the Dolby Vision original. A file with Dolby Vision can only be changed when Dolby Vision is removed as well, because the MKV keeps Dolby Vision's configuration on the video track, which a rebuilt track would lose.

Choose **Every MKV in a folder** to queue the same changes for a whole folder, optionally with its subfolders, up to 500 files. A folder can keep, measure or remove HDR10+, but not import it, since every file would need its own original. Files the changes do not fit are skipped and keep their content: SDR files when adding HDR10+, files that already have HDR10+ when **Leave files that already have HDR10+ as they are** is on, and files with nothing to remove. The job shows why it skipped a file.

## Film Grain

**Tools -> Film Grain** changes the film grain synthesis of AV1 MKVs that already exist, without re-encoding them. The player draws AV1 film grain from a few values in every frame header, so changing it leaves the encoded picture and the file size as they are. Use it to take grain out of an encode you do not like, to add a little grain that hides banding in clean or animated video, or to make grain weaker or stronger after watching the result.

Choose **One file** to inspect a video first. Rabbit reads its film grain with regrain and shows how many table entries it has, the average and strongest luma grain and the chroma grain on the 0 to 255 scale, and the problems `regrain check` finds. The modal shows how far the reading is: regrain first reads the table out of the video, then describes and checks every entry on all CPU threads. A film with an entry for every frame, as SVT-AV1 writes it, takes under half a minute. **Download table** saves the video's film grain table, which can be edited and uploaded again or applied to another video.

| Film grain                           | What it does                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Grain of a chosen strength**       | An ISO or a luma deviation, chroma, and Fine, Medium or Coarse grain, written with `regrain generate` like the encode's synthetic grain. The ISO is for the video's frame size |
| **Film grain table**                 | An uploaded `.tbl` from regrain, aomenc or **Download table**, matched to the video by time                                                                                    |
| **Grain measured from the original** | `regrain diff` compares the original with the video and puts back the grain the encode lost, optionally just enough to hide banding                                            |
| **Remove it**                        | The video plays without grain                                                                                                                                                  |

An uploaded table is checked with `regrain check`, and what `--fix` can correct is corrected, such as comments above the `filmgrn1` line or scaling points out of order. A table with errors regrain cannot correct is refused. **Static grain pattern** gives every frame of a table entry the same pattern, so it stands still instead of moving. Adding grain to a video that has some replaces it. Every change becomes a job with **Analyze**, **Write** and **Replace** steps: Rabbit extracts the AV1 track, writes the grain with regrain, decodes the result with dav1d, and rebuilds and verifies the MKV the same way as the HDR Metadata tool before it replaces the original. A file with Dolby Vision cannot be changed, because a rebuilt video track loses Dolby Vision's configuration. Remove it with HDR Metadata first.

Measuring takes the original the video was encoded from, with the same frames. Rabbit finds the crop and the downscale between them on its own, the way its encodes cut black bars and scale to 1080p, and takes out the video's own grain first so it does not count as grain the encode lost. **Quick (30 s)** measures a representative half minute and gives the whole video that grain, **Full video** gives every scene its own, and **Scan** reads only part of each 48 frames to go faster. Luma grain measured this way matched the grain measured against the clean source within 1% on 360p and 720p test videos from CRF 20 to 45. Chroma is measured only with **Measure chroma grain too**, because colour detail the encode lost counts as chroma grain: a source without any chroma grain measured 0.9 to 5.4 on the 0 to 255 scale from CRF 25 to 45. A folder cannot measure, since every file needs its own original.

Choose **Every MKV in a folder** to queue the same change for a whole folder, optionally with its subfolders, up to 500 files. Files without grain are skipped when removing it, and files that already have grain when **Leave files that already have film grain as they are** is on.

## Denoising

Denoising runs in the **Prepare** step, after crop / downscale / deband. The **Denoise** setting picks the level (`off`, `auto`, `light`, `medium`, `heavy`) and **Video handling -> Denoiser** picks what does the work:

| Engine           | Runs on               | Notes                                                                                                                                                        |
| ---------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `avd-nl4d`       | GPU only              | [av-denoise](https://github.com/ChillFish8/av-denoise) NL4D spatio-temporal denoiser. The default. Best noise removal and detail retention, and the slowest. |
| `avd-nlmeans-hq` | GPU only              | av-denoise NLMeans-HQ. Measures the noise level itself and keeps more detail than plain NLMeans.                                                             |
| `avd-nlmeans`    | GPU only              | av-denoise fast NLMeans. Hand-set strength, light denoising only.                                                                                            |
| `nlmeans`        | CPU, OpenCL or Vulkan | FFmpeg's nlmeans. Falls back to CPU when no GPU backend works.                                                                                               |

The av-denoise engines use Vulkan (or CUDA when an NVIDIA GPU is passed through to the container) and have no CPU fallback: if av-denoise cannot use the selected device, the job fails instead of encoding without denoising. Vulkan works with the `/dev/dri` device mapping from the stock `docker-compose.yml` on AMD and Intel GPUs.

The engines differ in how the level is used:

- **`avd-nl4d`** (the default denoiser) and **`avd-nlmeans-hq`** model the noise in each scene themselves and set their own strength. `light`, `medium` and `heavy` therefore denoise identically, and the level only decides whether a scene is denoised. Each has a single expert scale in Advanced Settings (`--lambda-ht-scale` / `--hq-sigma-scale`, default 1.0) that applies at every level.
- **`avd-nlmeans`** needs its strength set by hand, like FFmpeg nlmeans, so `light` / `medium` / `heavy` map to `--strength` 1.0 / 1.5 / 2.0, the same values as the FFmpeg nlmeans levels. The value applies to both luma and chroma.

The two NLMeans engines also have an **AVD Speed Preset** (`veryfast` to `veryslow`) that trades speed for quality. NL4D always runs at its default preset.

**Auto denoise** works with every engine. Scenes are classified by noise or by bitrate against your thresholds exactly as before, then each classified range is denoised by the selected engine and untouched ranges are passed through. With `avd-nl4d` and `avd-nlmeans-hq` every scene at or above the light threshold is denoised the same way, and neighbouring ranges are denoised as one stretch.

The first run with a new combination of av-denoise settings compiles GPU kernels, which takes a few seconds. They are cached in `/config/vapoursynth/av-denoise-cache` (override with `AV_DENOISE_COMPILATION_CACHE`).

The **Benchmark** dialog measures every engine at all three levels. Tick the engines you want to compare before running it.

## VapourSynth Filters

Rabbit Encoder ships with a VapourSynth filter system that lets you stack arbitrary preprocessing passes in front of the main encode. Each filter runs as its own `vspipe` pass.

### Stock presets

Built-in presets live under `/app/vapoursynth/presets` inside the container and are namespaced as `stock:<id>`:

| Preset ID               | Name             | Description                                                                                                                                                                                                                                                                   |
| ----------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stock:finedehalo`      | FineDehalo       | Reduces dark/bright halos around high-contrast edges. Best for anime and DVD upscales.                                                                                                                                                                                        |
| `stock:dehalo_alpha`    | Dehalo Alpha     | Classic halo reduction via `vs-jetpack`'s `dehalo_alpha`.                                                                                                                                                                                                                     |
| `stock:f3k_deband`      | F3K Deband       | Removes color banding in smooth gradients while preserving detail. Wraps `vszip.Deband` (modern f3kdb successor) and can re-grain after debanding.                                                                                                                            |
| `stock:source_bitdepth` | Source bit depth | Choose 8, 10, 12, or 16 bits for the filter pass. By default, sources below 10 bits are raised to 10 bits. Turn on **Convert sources above target** to reduce sources with more bits. Reductions use ordered dithering. The preset does not trim frames or change frame rate. |

Every preset declares its own `levels` (typically `light`, `medium`, `heavy`) and a set of tunable parameters. You can pick a level per job and override individual params per-level in the dashboard's **Advanced Settings -> VapourSynth Filters** panel.

The source bit depth preset changes the video sent to later filters. The final AV1 encode converts video to 10 bits. Choosing 8 or 12 bits for this preset does not make an output file with that bit depth. Reducing bit depth discards precision even if a later filter raises it again.

### User custom presets

To add your own filter, drop a matching pair of files into the host-mounted user directory (`./vapoursynth-user/presets` by default, exposed inside the container at `/config/vapoursynth/presets`):

```
myfilter.vpy    # the VapourSynth script
myfilter.json   # the manifest (id, levels, params, defaults)
```

Both files must share the same stem. The `.vpy` script reads its input path from the `SRC` argument and any tunable parameter via `rabbit_vs.arg_int / arg_float / arg_str / arg_bool`. See [**Examples**](https://github.com/Rabbit-Company/RabbitEncoder/tree/main/vapoursynth/presets).

User presets are namespaced as `user:<id>` and override nothing (stock and user presets coexist). After editing or adding presets, click **Reload presets** in the Advanced Settings panel (or `POST /api/vs-presets/reload`). No container restart is required.

### Per-job behavior

The VapourSynth chain is stored per job, so different files in the same queue can use different filter stacks. Each entry has a `level` (or `"off"` to disable without removing it from the chain) and a per-level parameter map, letting you switch intensity without losing your tweaks at other levels. The active chain and its resolved parameters are stored in the output MKV's versioned `SETTINGS` code (for example, `RE1|...`) so the configuration can be reproduced later.

## Subtitle Fonts

Subtitles are styled per **font group**. A group is a folder under the user fonts
directory (`/config/fonts`) containing one or more font files plus an optional
`metadata.json`. A single group can supply different faces for different writing
systems. For example a Latin-only face like Trebuchet MS together with a CJK
face like Noto Sans JP. This lets one group cover scripts that no single font does.

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
they belong in the per-key override for that face (a static Latin face has none,
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
never written to. Import always copies into `/config/fonts`.

You can still edit a group's style from the dashboard ("Subtitle font & style..."),
choosing a scope of "Group global" or a specific script/language. Saving writes
back to the group's `metadata.json`. Click **Reload fonts** (or
`POST /api/fonts/reload`) after hand-editing files on disk.

Variable-font axes are instanced into static fonts before attachment. When a
retained source font already uses the selected internal family name, Rabbit
Encoder picks the first free numbered alias (`Noto Sans` → `Noto Sans 2` →
`Noto Sans 3`), written consistently into the static font's internal metadata and
the ASS styles it rewrites. The attachment **filename** is slugified
(`Noto Sans 2` -> `noto_sans_2.ttf`). The internal family name keeps its spaces,
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

When an AV1 film grain table was used for the encode, the code carries `fg=1` in its core section, for example `RE1|c~fg=1`. The flag is left out when no table was used. It only records that a table was used. The table itself and its path are not stored, so importing a code never changes a job's film grain table.

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
| `POST`   | `/api/jobs/:id/preview`                     | Start a preview encode. The optional body configures sample count and duration |
| `DELETE` | `/api/jobs/:id/preview`                     | Cancel a running preview, or clear completed preview artifacts                 |
| `GET`    | `/api/jobs/:id/preview/sample/:index/:kind` | Fetch source/encode clips, comparison PNGs, VS stills, or prepare-stage stills |
| `GET`    | `/api/repair/inspect`                       | Inspect target/source MKV subtitle tracks for the repair editor                |
| `GET`    | `/api/repair/roots`                         | List configured media roots for the repair file picker                         |
| `GET`    | `/api/repair/browse`                        | Browse MKV files within an allowed repair-picker root                          |
| `POST`   | `/api/repair/audit`                         | Group a folder or completed job outputs by audio/subtitle metadata             |
| `POST`   | `/api/repair/audit/group`                   | Validate an audited group and queue subtitle metadata edits for all its files  |
| `POST`   | `/api/repair/jobs`                          | Validate and queue a subtitle-only stream-copy repair plan                     |
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
| `POST`   | `/api/queue/pause`                          | Pause encoding. Stops current encode and preserves the queue                   |
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
| `GET`    | `/api/avd-devices`                          | List GPU devices usable by av-denoise                                          |
| `GET`    | `/api/benchmark`                            | Get current benchmark state                                                    |
| `POST`   | `/api/benchmark`                            | Start a denoise benchmark run                                                  |
| `DELETE` | `/api/benchmark`                            | Cancel a running benchmark                                                     |
| `GET`    | `/api/vs-presets`                           | List all VapourSynth presets (stock + user) with their manifests               |
| `POST`   | `/api/vs-presets/reload`                    | Rescan stock and user preset directories from disk and reload the registry     |
| `GET`    | `/api/vs-presets/:id/default-entry`         | Build a fresh filter-chain entry for `:id`, pre-filled with manifest defaults  |

## License

GPL-3.0
