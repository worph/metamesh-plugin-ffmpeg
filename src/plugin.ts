/**
 * FFmpeg Plugin
 *
 * Extracts video/audio/subtitle stream metadata using FFprobe.
 * Depends on file-info plugin to determine file type.
 *
 * Storage format:
 * - fileinfo/duration = "123.45"
 * - fileinfo/formatName = "matroska,webm"
 * - stream/0 = '{"type":"video","codec":"h264","width":1920,...}' (JSON string)
 * - stream/1 = '{"type":"audio","codec":"aac","language":"eng",...}' (JSON string)
 *
 * Each stream is stored as a JSON string at the stream level.
 */

import ffmpeg from 'fluent-ffmpeg';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { readJson, writeJson } from './cache.js';
import { createWebDAVClient, WebDAVClient } from './webdav-client.js';

// Initialize WebDAV client if WEBDAV_URL is set
const webdavClient = createWebDAVClient();
if (webdavClient) {
    console.log('[ffmpeg] Using WebDAV for file access');
} else {
    console.log('[ffmpeg] Using direct filesystem access');
}

export const manifest: PluginManifest = {
    id: 'ffmpeg',
    name: 'FFmpeg Metadata',
    version: '1.0.0',
    description: 'Extracts video/audio/subtitle stream metadata using FFprobe',
    author: 'MetaMesh',
    dependencies: ['file-info'],
    priority: 15,
    color: '#4CAF50',
    defaultQueue: 'fast',
    timeout: 60000,
    schema: {
        'fileinfo/duration': { label: 'Duration', type: 'string', readonly: true },
        'fileinfo/formatName': { label: 'Format Name', type: 'string', readonly: true },
        // Streams are stored as stream/0, stream/1, etc. - each is a JSON string
        'stream/*': {
            label: 'Stream',
            type: 'json',
            readonly: true,
            hint: 'Stream metadata (video/audio/subtitle) as JSON string',
        },
    },
    config: {},
};

interface FFprobeData {
    format?: {
        duration?: number;
        format_name?: string;
    };
    streams?: Array<{
        codec_type?: string;
        codec_name?: string;
        index?: number;
        duration?: string;
        width?: number;
        height?: number;
        bit_rate?: string;
        avg_frame_rate?: string;
        sample_rate?: string;
        channel_layout?: string;
        disposition?: {
            forced?: number;
            default?: number;
        };
        tags?: {
            language?: string;
            title?: string;
            rotate?: string;
        };
    }>;
}

interface FileInfoCache {
    duration?: string;
    formatName?: string;
    streamdetails?: {
        video?: Record<string, Record<string, string>>;
        audio?: Record<string, Record<string, string>>;
        subtitle?: Record<string, Record<string, string>>;
        embeddedimage?: Record<string, Record<string, string>>;
    };
}

/**
 * Run FFprobe on a file path or URL
 * FFprobe natively supports HTTP URLs for input
 */
function runFFprobe(inputPath: string): Promise<FFprobeData> {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath).ffprobe((err, data) => {
            if (err) reject(err);
            else resolve(data as FFprobeData);
        });
    });
}

/**
 * Get the input path for FFprobe - WebDAV URL or local file path
 */
function getFFprobeInput(filePath: string): string {
    if (webdavClient) {
        // FFprobe can read from HTTP URLs directly
        return webdavClient.toWebDAVUrl(filePath);
    }
    return filePath;
}

export async function process(
    request: ProcessRequest,
    sendCallback: (payload: CallbackPayload) => Promise<void>
): Promise<void> {
    const startTime = Date.now();
    const metaCore = new MetaCoreClient(request.metaCoreUrl);

    try {
        const { cid, filePath, existingMeta } = request;

        // Only process video files (from file-info plugin)
        const fileType = existingMeta?.fileType;
        if (fileType !== 'video') {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Not a video file',
            });
            return;
        }

        // Check if already processed
        if (existingMeta?.['fileinfo/duration']) {
            await sendCallback({
                taskId: request.taskId,
                status: 'skipped',
                duration: Date.now() - startTime,
                reason: 'Already processed',
            });
            return;
        }

        // Check cache using midhash256 if available
        const midhash = existingMeta?.['cid_midhash256'];
        if (midhash) {
            const cachedData = await readJson<FileInfoCache>(`${midhash}.json`);
            if (cachedData) {
                console.log(`[ffmpeg] Using cached FFprobe data for ${filePath}`);
                await applyCachedMetadata(metaCore, cid, cachedData);
                await sendCallback({
                    taskId: request.taskId,
                    status: 'completed',
                    duration: Date.now() - startTime,
                });
                return;
            }
        }

        // Run FFprobe (uses WebDAV URL if available, otherwise local path)
        const ffprobeInput = getFFprobeInput(filePath);
        const data = await runFFprobe(ffprobeInput);
        const metadata: Record<string, string> = {};
        const fileinfo: FileInfoCache = { streamdetails: {} };

        // Format metadata
        if (data.format?.duration != null) {
            const duration = String(data.format.duration);
            metadata['fileinfo/duration'] = duration;
            fileinfo.duration = duration;
        }
        if (data.format?.format_name) {
            const formatName = String(data.format.format_name);
            metadata['fileinfo/formatName'] = formatName;
            fileinfo.formatName = formatName;
        }

        // Global stream counter (all streams share one index)
        let globalStreamIndex = 0;

        // Process each stream - store as JSON string at stream level
        for (const stream of data.streams || []) {
            if (!stream) continue;

            const codecType = String(stream.codec_type || '');
            let streamType: 'video' | 'audio' | 'subtitle' | 'embeddedimage';

            if (codecType === 'video') {
                streamType = 'video';
            } else if (codecType === 'audio') {
                streamType = 'audio';
            } else if (codecType === 'subtitle') {
                streamType = 'subtitle';
            } else if (codecType === 'embeddedimage') {
                streamType = 'embeddedimage';
            } else {
                continue;
            }

            // Build stream object with all relevant fields
            const streamData: Record<string, string | number | boolean> = {
                type: streamType,
            };

            // Common fields
            if (stream.codec_name) {
                streamData.codec = String(stream.codec_name);
            }
            if (stream.index != null) {
                streamData.index = stream.index;
            }
            if (stream.duration) {
                streamData.duration = String(stream.duration);
            }
            if (stream.disposition?.forced != null) {
                streamData.forced = stream.disposition.forced === 1;
            }
            if (stream.disposition?.default != null) {
                streamData.default = stream.disposition.default === 1;
            }
            if (stream.tags?.language) {
                streamData.language = String(stream.tags.language);
            }
            if (stream.tags?.title) {
                streamData.title = String(stream.tags.title);
            }

            // Video-specific fields
            if (stream.width && stream.width !== ('N/A' as unknown)) {
                streamData.width = stream.width;
            }
            if (stream.height && stream.height !== ('N/A' as unknown)) {
                streamData.height = stream.height;
            }
            if (stream.bit_rate && stream.bit_rate !== 'N/A') {
                streamData.bitrate = String(stream.bit_rate);
            }
            if (stream.avg_frame_rate && stream.avg_frame_rate !== '0/0') {
                streamData.frameRate = String(stream.avg_frame_rate);
            }
            if (stream.tags?.rotate) {
                streamData.rotation = String(stream.tags.rotate);
            }

            // Audio-specific fields
            if (stream.sample_rate) {
                streamData.sampleRate = String(stream.sample_rate);
            }
            if (stream.channel_layout) {
                streamData.channelLayout = String(stream.channel_layout);
            }

            // Store stream as JSON string at stream/{n}
            metadata[`stream/${globalStreamIndex}`] = JSON.stringify(streamData);

            // Initialize stream object for cache (keep old format for backwards compat)
            if (!fileinfo.streamdetails![streamType]) {
                fileinfo.streamdetails![streamType] = {};
            }
            // Store stringified fields in cache for reconstruction
            const typeStreamIndex = Object.keys(fileinfo.streamdetails![streamType]!).length;
            fileinfo.streamdetails![streamType]![typeStreamIndex] = {};
            const streamCache = fileinfo.streamdetails![streamType]![typeStreamIndex];
            for (const [key, value] of Object.entries(streamData)) {
                if (key !== 'type') {
                    streamCache[key] = String(value);
                }
            }

            globalStreamIndex++;
        }

        // Write to meta-core
        await metaCore.mergeMetadata(cid, metadata);

        // Cache the fileinfo object for future use
        if (midhash) {
            await writeJson(`${midhash}.json`, fileinfo);
        }

        const duration = Date.now() - startTime;
        const mode = webdavClient ? 'WebDAV' : 'filesystem';
        console.log(`[ffmpeg] Processed in ${duration}ms (${mode})`);

        await sendCallback({
            taskId: request.taskId,
            status: 'completed',
            duration,
        });
    } catch (error) {
        const duration = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(`[ffmpeg] Error:`, errorMessage);
        console.error(
            'Make sure FFmpeg/FFprobe is installed. ' +
            'Windows: set FFMPEG_PATH and FFPROBE_PATH environment variables. ' +
            'Linux: install ffmpeg package.'
        );

        await sendCallback({
            taskId: request.taskId,
            status: 'failed',
            duration,
            error: errorMessage,
        });
    }
}

/**
 * Apply cached metadata to meta-core
 */
async function applyCachedMetadata(
    metaCore: MetaCoreClient,
    cid: string,
    fileinfo: FileInfoCache
): Promise<void> {
    const metadata: Record<string, string> = {};

    if (fileinfo.duration != null) {
        metadata['fileinfo/duration'] = String(fileinfo.duration);
    }
    if (fileinfo.formatName) {
        metadata['fileinfo/formatName'] = String(fileinfo.formatName);
    }

    // Apply streamdetails - store each stream as JSON string at stream/{n}
    const streamdetails = fileinfo.streamdetails || {};
    let globalStreamIndex = 0;

    for (const streamType of ['video', 'audio', 'subtitle', 'embeddedimage'] as const) {
        const streams = streamdetails[streamType] || {};
        for (const [, stream] of Object.entries(streams)) {
            // Build stream object with type
            const streamData: Record<string, string | number | boolean> = {
                type: streamType,
            };
            for (const [key, value] of Object.entries(stream)) {
                if (value != null) {
                    // Try to parse numbers and booleans back to their original types
                    if (value === 'true') {
                        streamData[key] = true;
                    } else if (value === 'false') {
                        streamData[key] = false;
                    } else if (!isNaN(Number(value)) && value !== '') {
                        streamData[key] = Number(value);
                    } else {
                        streamData[key] = value;
                    }
                }
            }
            // Store as JSON string
            metadata[`stream/${globalStreamIndex}`] = JSON.stringify(streamData);
            globalStreamIndex++;
        }
    }

    await metaCore.mergeMetadata(cid, metadata);
}
