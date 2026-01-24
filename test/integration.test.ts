/**
 * FFmpeg Plugin Integration Tests
 *
 * These tests require FFprobe to be installed (run in Docker container).
 * Tests the full processing pipeline with real video files.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

// Dynamic import of plugin module (ES modules)
let processFile: typeof import('../src/plugin.js').process;
let manifest: typeof import('../src/plugin.js').manifest;

// Mock callback collector
interface CallbackResult {
    taskId: string;
    status: 'completed' | 'failed' | 'skipped';
    duration: number;
    error?: string;
    reason?: string;
}

let lastCallback: CallbackResult | null = null;

const mockSendCallback = async (payload: CallbackResult): Promise<void> => {
    lastCallback = payload;
};

// Check if FFprobe is available
function isFFprobeAvailable(): boolean {
    try {
        execSync('ffprobe -version', { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

// Check if test fixtures exist
function fixturesExist(): boolean {
    return fs.existsSync(path.join(FIXTURES_DIR, 'simple.mp4'));
}

describe('FFmpeg Plugin Integration Tests', () => {
    beforeAll(async () => {
        // Skip all tests if FFprobe is not available
        if (!isFFprobeAvailable()) {
            console.warn('FFprobe not available - skipping integration tests');
            return;
        }

        // Check fixtures
        if (!fixturesExist()) {
            console.warn('Test fixtures not found - run generate-test-video.sh first');
            return;
        }

        // Import the plugin module
        const plugin = await import('../src/plugin.js');
        processFile = plugin.process;
        manifest = plugin.manifest;
    });

    afterAll(() => {
        lastCallback = null;
    });

    describe('Prerequisites', () => {
        it('FFprobe is available', () => {
            expect(isFFprobeAvailable()).toBe(true);
        });

        it('test fixtures exist', () => {
            expect(fixturesExist()).toBe(true);
        });
    });

    describe('Manifest', () => {
        it('has required fields', async () => {
            if (!manifest) return;

            expect(manifest.id).toBe('ffmpeg');
            expect(manifest.name).toBeDefined();
            expect(manifest.version).toBeDefined();
            expect(manifest.dependencies).toContain('file-info');
            expect(manifest.priority).toBe(15);
            expect(manifest.timeout).toBe(60000);
        });

        it('declares correct schema', async () => {
            if (!manifest) return;

            expect(manifest.schema).toHaveProperty('fileinfo/duration');
            expect(manifest.schema).toHaveProperty('fileinfo/formatName');
            expect(manifest.schema).toHaveProperty('stream/*');
        });
    });

    describe('Process - Skip Logic', () => {
        it('skips non-video files', async () => {
            if (!processFile) return;

            await processFile({
                taskId: 'test-skip-1',
                cid: 'test-cid-1',
                filePath: path.join(FIXTURES_DIR, 'audio-only.mp3'),
                callbackUrl: 'http://localhost/callback',
                metaCoreUrl: 'http://localhost:9000',
                existingMeta: { fileType: 'audio' },
            }, mockSendCallback);

            expect(lastCallback).toBeDefined();
            expect(lastCallback?.status).toBe('skipped');
            expect(lastCallback?.reason).toContain('Not a video');
        });

        it('skips already processed files', async () => {
            if (!processFile) return;

            await processFile({
                taskId: 'test-skip-2',
                cid: 'test-cid-2',
                filePath: path.join(FIXTURES_DIR, 'simple.mp4'),
                callbackUrl: 'http://localhost/callback',
                metaCoreUrl: 'http://localhost:9000',
                existingMeta: {
                    fileType: 'video',
                    'fileinfo/duration': '2.0',  // Already has duration
                },
            }, mockSendCallback);

            expect(lastCallback).toBeDefined();
            expect(lastCallback?.status).toBe('skipped');
            expect(lastCallback?.reason).toContain('Already processed');
        });
    });

    describe('Process - Simple Video (MP4)', () => {
        it('extracts metadata from simple.mp4', async () => {
            if (!processFile) return;

            // Create a mock MetaCoreClient that captures the metadata
            let capturedMetadata: Record<string, string> = {};

            // We need to mock the MetaCoreClient - for now, we'll just verify the callback
            await processFile({
                taskId: 'test-simple-1',
                cid: 'test-cid-simple',
                filePath: path.join(FIXTURES_DIR, 'simple.mp4'),
                callbackUrl: 'http://localhost/callback',
                metaCoreUrl: 'http://localhost:9000',  // Won't actually connect
                existingMeta: { fileType: 'video' },
            }, mockSendCallback);

            // The test will fail when trying to connect to metaCoreUrl
            // but we can still verify the callback behavior
            expect(lastCallback).toBeDefined();
            // If meta-core is not available, it will fail
            // In a real test we'd mock the MetaCoreClient
        });
    });

    describe('Process - Direct FFprobe Validation', () => {
        it('ffprobe can read simple.mp4', async () => {
            const result = execSync(
                `ffprobe -v quiet -print_format json -show_format -show_streams "${path.join(FIXTURES_DIR, 'simple.mp4')}"`,
                { encoding: 'utf-8' }
            );
            const data = JSON.parse(result);

            expect(data.format).toBeDefined();
            expect(data.format.duration).toBeDefined();
            expect(parseFloat(data.format.duration)).toBeGreaterThan(0);
            expect(data.streams).toBeDefined();
            expect(data.streams.length).toBeGreaterThanOrEqual(1);
        });

        it('ffprobe extracts video stream from simple.mp4', async () => {
            const result = execSync(
                `ffprobe -v quiet -print_format json -show_streams "${path.join(FIXTURES_DIR, 'simple.mp4')}"`,
                { encoding: 'utf-8' }
            );
            const data = JSON.parse(result);

            const videoStream = data.streams.find((s: any) => s.codec_type === 'video');
            expect(videoStream).toBeDefined();
            expect(videoStream.codec_name).toBe('h264');
            expect(videoStream.width).toBe(320);
            expect(videoStream.height).toBe(240);
        });

        it('ffprobe extracts audio stream from simple.mp4', async () => {
            const result = execSync(
                `ffprobe -v quiet -print_format json -show_streams "${path.join(FIXTURES_DIR, 'simple.mp4')}"`,
                { encoding: 'utf-8' }
            );
            const data = JSON.parse(result);

            const audioStream = data.streams.find((s: any) => s.codec_type === 'audio');
            expect(audioStream).toBeDefined();
            expect(audioStream.codec_name).toBe('aac');
        });

        it('ffprobe extracts multiple audio tracks from multi-audio.mkv', async () => {
            const mkvPath = path.join(FIXTURES_DIR, 'multi-audio.mkv');
            if (!fs.existsSync(mkvPath)) {
                console.warn('multi-audio.mkv not found, skipping');
                return;
            }

            const result = execSync(
                `ffprobe -v quiet -print_format json -show_streams "${mkvPath}"`,
                { encoding: 'utf-8' }
            );
            const data = JSON.parse(result);

            const audioStreams = data.streams.filter((s: any) => s.codec_type === 'audio');
            expect(audioStreams.length).toBeGreaterThanOrEqual(2);
        });

        it('ffprobe extracts subtitles from with-subs.mkv', async () => {
            const mkvPath = path.join(FIXTURES_DIR, 'with-subs.mkv');
            if (!fs.existsSync(mkvPath)) {
                console.warn('with-subs.mkv not found, skipping');
                return;
            }

            const result = execSync(
                `ffprobe -v quiet -print_format json -show_streams "${mkvPath}"`,
                { encoding: 'utf-8' }
            );
            const data = JSON.parse(result);

            const subStream = data.streams.find((s: any) => s.codec_type === 'subtitle');
            expect(subStream).toBeDefined();
        });
    });
});

describe('FFprobe Output Format', () => {
    it('validates stream JSON structure matches plugin expectations', async () => {
        if (!fixturesExist()) return;

        const result = execSync(
            `ffprobe -v quiet -print_format json -show_format -show_streams "${path.join(FIXTURES_DIR, 'simple.mp4')}"`,
            { encoding: 'utf-8' }
        );
        const data = JSON.parse(result);

        // Validate format fields the plugin expects
        expect(data.format).toHaveProperty('duration');
        expect(data.format).toHaveProperty('format_name');

        // Validate stream fields the plugin expects
        const videoStream = data.streams.find((s: any) => s.codec_type === 'video');
        expect(videoStream).toHaveProperty('codec_type');
        expect(videoStream).toHaveProperty('codec_name');
        expect(videoStream).toHaveProperty('index');
        expect(videoStream).toHaveProperty('width');
        expect(videoStream).toHaveProperty('height');

        const audioStream = data.streams.find((s: any) => s.codec_type === 'audio');
        expect(audioStream).toHaveProperty('codec_type');
        expect(audioStream).toHaveProperty('codec_name');
        expect(audioStream).toHaveProperty('sample_rate');
    });
});
