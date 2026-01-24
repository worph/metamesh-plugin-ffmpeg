#!/bin/bash
# Generate minimal test videos for FFprobe integration tests
# Run inside Docker container with FFmpeg installed

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Generating test video files..."

# 1. Simple video with video + audio streams (2 seconds, ~100KB)
if [ ! -f "simple.mp4" ]; then
    echo "Creating simple.mp4..."
    ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=24 \
           -f lavfi -i sine=frequency=440:duration=2 \
           -c:v libx264 -preset ultrafast -crf 28 \
           -c:a aac -b:a 64k \
           -shortest \
           simple.mp4
fi

# 2. Video with multiple audio tracks (for multi-stream testing)
if [ ! -f "multi-audio.mkv" ]; then
    echo "Creating multi-audio.mkv..."
    ffmpeg -y -f lavfi -i testsrc=duration=2:size=640x480:rate=30 \
           -f lavfi -i sine=frequency=440:duration=2 \
           -f lavfi -i sine=frequency=880:duration=2 \
           -c:v libx264 -preset ultrafast -crf 28 \
           -filter_complex "[1:a]aformat=channel_layouts=stereo[a1];[2:a]aformat=channel_layouts=stereo[a2]" \
           -map 0:v -map "[a1]" -map "[a2]" \
           -c:a aac -b:a 64k \
           -metadata:s:a:0 language=eng -metadata:s:a:0 title="English" \
           -metadata:s:a:1 language=jpn -metadata:s:a:1 title="Japanese" \
           multi-audio.mkv
fi

# 3. Video with subtitles (if possible, create with embedded subs)
if [ ! -f "with-subs.mkv" ]; then
    echo "Creating with-subs.mkv..."
    # Create a simple SRT file
    cat > temp_subs.srt << 'EOF'
1
00:00:00,000 --> 00:00:01,000
Test subtitle line 1

2
00:00:01,000 --> 00:00:02,000
Test subtitle line 2
EOF

    ffmpeg -y -f lavfi -i testsrc=duration=2:size=320x240:rate=24 \
           -f lavfi -i sine=frequency=440:duration=2 \
           -i temp_subs.srt \
           -c:v libx264 -preset ultrafast -crf 28 \
           -c:a aac -b:a 64k \
           -c:s srt \
           -metadata:s:s:0 language=eng \
           with-subs.mkv

    rm -f temp_subs.srt
fi

# 4. Audio-only file (should be skipped by FFmpeg plugin)
if [ ! -f "audio-only.mp3" ]; then
    echo "Creating audio-only.mp3..."
    ffmpeg -y -f lavfi -i sine=frequency=440:duration=2 \
           -c:a libmp3lame -b:a 128k \
           audio-only.mp3
fi

echo "Test fixtures generated:"
ls -la *.mp4 *.mkv *.mp3 2>/dev/null || true
