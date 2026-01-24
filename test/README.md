# FFmpeg Plugin Tests

Integration tests for the FFmpeg metadata extraction plugin.

## Requirements

Tests require FFprobe to be installed. Since FFprobe is typically only available in the Docker container, tests are designed to run inside Docker.

## Running Tests

### Quick Start (Recommended)

```bash
# From the plugin directory
./test.sh
```

This builds a test Docker image and runs all tests inside it.

### Options

```bash
./test.sh --no-cache   # Rebuild without Docker cache
./test.sh --shell      # Start interactive shell for debugging
```

### Running Locally (if FFprobe is installed)

```bash
npm install
npm test
```

## Test Structure

```
test/
├── fixtures/
│   ├── generate-test-video.sh   # Generates test video files
│   ├── simple.mp4               # Basic video + audio (generated)
│   ├── multi-audio.mkv          # Multiple audio tracks (generated)
│   ├── with-subs.mkv            # Video with subtitles (generated)
│   └── audio-only.mp3           # Audio file for skip tests (generated)
├── integration.test.ts          # Integration tests
└── README.md                    # This file
```

## Test Categories

### Integration Tests (`integration.test.ts`)

1. **Prerequisites** - Verify FFprobe and fixtures are available
2. **Manifest** - Validate plugin manifest structure
3. **Skip Logic** - Test that non-video files are skipped
4. **FFprobe Validation** - Direct FFprobe output verification
5. **Output Format** - Validate FFprobe JSON matches plugin expectations

## Test Fixtures

Test fixtures are generated automatically during Docker build using `generate-test-video.sh`. The script creates:

- `simple.mp4` - 2-second 320x240 H.264 video with AAC audio
- `multi-audio.mkv` - Video with two audio tracks (English + Japanese)
- `with-subs.mkv` - Video with embedded SRT subtitles
- `audio-only.mp3` - Audio file (for testing skip logic)

## Writing New Tests

```typescript
import { describe, it, expect } from 'vitest';
import path from 'path';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');

describe('My New Test', () => {
    it('does something', async () => {
        // Your test here
    });
});
```

## Debugging

Start an interactive shell in the test container:

```bash
./test.sh --shell

# Inside container:
npm test                          # Run all tests
npx vitest run -t "skip"          # Run tests matching "skip"
ffprobe test/fixtures/simple.mp4  # Manually inspect video
```
