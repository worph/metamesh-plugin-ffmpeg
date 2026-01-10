# MetaMesh Plugin: FFmpeg

A MetaMesh plugin that extracts video, audio, and subtitle stream metadata using FFprobe.

## Description

This plugin analyzes video files using FFprobe (from FFmpeg) to extract detailed stream information including:

- **Video streams**: codec, resolution, bitrate, frame rate, rotation
- **Audio streams**: codec, language, sample rate, channels
- **Subtitle streams**: codec, language, title
- **Format info**: duration, container format

## Metadata Fields

| Field | Description |
|-------|-------------|
| `fileinfo/duration` | Video duration in seconds |
| `fileinfo/formatName` | Container format (e.g., matroska, mp4) |
| `fileinfo/streamdetails/video/{n}/*` | Video stream properties |
| `fileinfo/streamdetails/audio/{n}/*` | Audio stream properties |
| `fileinfo/streamdetails/subtitle/{n}/*` | Subtitle stream properties |

## Dependencies

- Requires `file-info` plugin to run first (checks `fileType === 'video'`)

## Configuration

No configuration required.

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/manifest` | GET | Plugin manifest |
| `/configure` | POST | Update configuration |
| `/process` | POST | Process a file |

## Running Locally

```bash
npm install
npm run build
npm start
```

## Docker

```bash
docker build -t metamesh-plugin-ffmpeg .
docker run -p 8080:8080 metamesh-plugin-ffmpeg
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8080` | HTTP server port |
| `HOST` | `0.0.0.0` | HTTP server host |

## License

MIT
