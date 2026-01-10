/**
 * FFmpeg Plugin
 *
 * Extracts video/audio/subtitle stream metadata using FFprobe.
 * Depends on file-info plugin to determine file type.
 *
 * Matches old FFMpegFileProcessor output:
 * - fileinfo/duration
 * - fileinfo/formatName
 * - fileinfo/streamdetails/video/{n}/codec, width, height, etc.
 * - fileinfo/streamdetails/audio/{n}/codec, language, etc.
 * - fileinfo/streamdetails/subtitle/{n}/codec, language, etc.
 */

import ffmpeg from 'fluent-ffmpeg';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';
import { readJson, writeJson } from './cache.js';

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
        'fileinfo/streamdetails/video': {
            label: 'Video Streams',
            type: 'json',
            readonly: true,
            hint: 'Video codec, resolution, bitrate, frame rate',
        },
        'fileinfo/streamdetails/audio': {
            label: 'Audio Streams',
            type: 'json',
            readonly: true,
            hint: 'Audio codec, language, sample rate, channels',
        },
        'fileinfo/streamdetails/subtitle': {
            label: 'Subtitle Streams',
            type: 'json',
            readonly: true,
            hint: 'Subtitle codec, language, title',
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

function runFFprobe(filePath: string): Promise<FFprobeData> {
    return new Promise((resolve, reject) => {
        ffmpeg(filePath).ffprobe((err, data) => {
            if (err) reject(err);
            else resolve(data as FFprobeData);
        });
    });
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

        // Run FFprobe
        const data = await runFFprobe(filePath);
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

        // Stream counters
        let videoStreamIndex = 0;
        let audioStreamIndex = 0;
        let subtitleStreamIndex = 0;
        let embeddedImageStreamIndex = 0;

        // Process each stream
        for (const stream of data.streams || []) {
            if (!stream) continue;

            const codecType = String(stream.codec_type || '');
            let basePath: string;
            let streamType: 'video' | 'audio' | 'subtitle' | 'embeddedimage';
            let streamIdx: number;

            if (codecType === 'video') {
                basePath = `fileinfo/streamdetails/video/${videoStreamIndex}`;
                streamType = 'video';
                streamIdx = videoStreamIndex++;
            } else if (codecType === 'audio') {
                basePath = `fileinfo/streamdetails/audio/${audioStreamIndex}`;
                streamType = 'audio';
                streamIdx = audioStreamIndex++;
            } else if (codecType === 'subtitle') {
                basePath = `fileinfo/streamdetails/subtitle/${subtitleStreamIndex}`;
                streamType = 'subtitle';
                streamIdx = subtitleStreamIndex++;
            } else if (codecType === 'embeddedimage') {
                basePath = `fileinfo/streamdetails/embeddedimage/${embeddedImageStreamIndex}`;
                streamType = 'embeddedimage';
                streamIdx = embeddedImageStreamIndex++;
            } else {
                continue;
            }

            // Initialize stream object for cache
            if (!fileinfo.streamdetails![streamType]) {
                fileinfo.streamdetails![streamType] = {};
            }
            fileinfo.streamdetails![streamType]![streamIdx] = {};
            const streamCache = fileinfo.streamdetails![streamType]![streamIdx];

            // Common fields
            if (stream.codec_name) {
                metadata[`${basePath}/codec`] = String(stream.codec_name);
                streamCache.codec = String(stream.codec_name);
            }
            if (stream.index != null) {
                metadata[`${basePath}/index`] = String(stream.index);
                streamCache.index = String(stream.index);
            }
            if (stream.duration) {
                metadata[`${basePath}/duration`] = String(stream.duration);
                streamCache.duration = String(stream.duration);
            }
            if (stream.codec_type) {
                metadata[`${basePath}/codecType`] = String(stream.codec_type);
                streamCache.codecType = String(stream.codec_type);
            }
            if (stream.disposition?.forced != null) {
                const forced = stream.disposition.forced ? 'true' : 'false';
                metadata[`${basePath}/forced`] = forced;
                streamCache.forced = forced;
            }
            if (stream.disposition?.default != null) {
                const defaultVal = stream.disposition.default ? 'true' : 'false';
                metadata[`${basePath}/default`] = defaultVal;
                streamCache.default = defaultVal;
            }
            if (stream.tags?.language) {
                metadata[`${basePath}/language`] = String(stream.tags.language);
                streamCache.language = String(stream.tags.language);
            }
            if (stream.tags?.title) {
                metadata[`${basePath}/title`] = String(stream.tags.title);
                streamCache.title = String(stream.tags.title);
            }

            // Video-specific fields
            if (stream.width && stream.width !== ('N/A' as unknown)) {
                metadata[`${basePath}/width`] = String(stream.width);
                streamCache.width = String(stream.width);
            }
            if (stream.height && stream.height !== ('N/A' as unknown)) {
                metadata[`${basePath}/height`] = String(stream.height);
                streamCache.height = String(stream.height);
            }
            if (stream.bit_rate && stream.bit_rate !== 'N/A') {
                metadata[`${basePath}/bitrate`] = String(stream.bit_rate);
                streamCache.bitrate = String(stream.bit_rate);
            }
            if (stream.avg_frame_rate && stream.avg_frame_rate !== '0/0') {
                metadata[`${basePath}/frameRate`] = String(stream.avg_frame_rate);
                streamCache.frameRate = String(stream.avg_frame_rate);
            }
            if (stream.tags?.rotate) {
                metadata[`${basePath}/rotation`] = String(stream.tags.rotate);
                streamCache.rotation = String(stream.tags.rotate);
            }

            // Audio-specific fields
            if (stream.sample_rate) {
                metadata[`${basePath}/sampleRate`] = String(stream.sample_rate);
                streamCache.sampleRate = String(stream.sample_rate);
            }
            if (stream.channel_layout) {
                metadata[`${basePath}/channelLayout`] = String(stream.channel_layout);
                streamCache.channelLayout = String(stream.channel_layout);
            }
        }

        // Write to meta-core
        await metaCore.mergeMetadata(cid, metadata);

        // Cache the fileinfo object for future use
        if (midhash) {
            await writeJson(`${midhash}.json`, fileinfo);
        }

        const duration = Date.now() - startTime;
        console.log(`[ffmpeg] Processed in ${duration}ms`);

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

    // Apply streamdetails
    const streamdetails = fileinfo.streamdetails || {};
    for (const streamType of ['video', 'audio', 'subtitle', 'embeddedimage'] as const) {
        const streams = streamdetails[streamType] || {};
        for (const [index, stream] of Object.entries(streams)) {
            const basePath = `fileinfo/streamdetails/${streamType}/${index}`;
            for (const [key, value] of Object.entries(stream)) {
                if (value != null) {
                    metadata[`${basePath}/${key}`] = String(value);
                }
            }
        }
    }

    await metaCore.mergeMetadata(cid, metadata);
}
