/**
 * FFmpeg Plugin
 *
 * Extracts video/audio/subtitle stream metadata using FFprobe.
 */

import ffmpeg from 'fluent-ffmpeg';
import type { PluginManifest, ProcessRequest, CallbackPayload } from './types.js';
import { MetaCoreClient } from './meta-core-client.js';

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

        // Only process video files
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

        // Run FFprobe
        const data = await runFFprobe(filePath);
        const metadata: Record<string, string> = {};

        // Format metadata
        if (data.format?.duration != null) {
            metadata['fileinfo/duration'] = String(data.format.duration);
        }
        if (data.format?.format_name) {
            metadata['fileinfo/formatName'] = data.format.format_name;
        }

        // Stream counters
        let videoIdx = 0, audioIdx = 0, subtitleIdx = 0;

        for (const stream of data.streams || []) {
            if (!stream) continue;

            const codecType = stream.codec_type || '';
            let basePath: string;

            if (codecType === 'video') {
                basePath = `fileinfo/streamdetails/video/${videoIdx++}`;
            } else if (codecType === 'audio') {
                basePath = `fileinfo/streamdetails/audio/${audioIdx++}`;
            } else if (codecType === 'subtitle') {
                basePath = `fileinfo/streamdetails/subtitle/${subtitleIdx++}`;
            } else {
                continue;
            }

            // Common fields
            if (stream.codec_name) metadata[`${basePath}/codec`] = stream.codec_name;
            if (stream.index != null) metadata[`${basePath}/index`] = String(stream.index);
            if (stream.duration) metadata[`${basePath}/duration`] = stream.duration;
            if (stream.codec_type) metadata[`${basePath}/codecType`] = stream.codec_type;
            if (stream.disposition?.forced != null) {
                metadata[`${basePath}/forced`] = stream.disposition.forced ? 'true' : 'false';
            }
            if (stream.disposition?.default != null) {
                metadata[`${basePath}/default`] = stream.disposition.default ? 'true' : 'false';
            }
            if (stream.tags?.language) metadata[`${basePath}/language`] = stream.tags.language;
            if (stream.tags?.title) metadata[`${basePath}/title`] = stream.tags.title;

            // Video-specific
            if (stream.width) metadata[`${basePath}/width`] = String(stream.width);
            if (stream.height) metadata[`${basePath}/height`] = String(stream.height);
            if (stream.bit_rate && stream.bit_rate !== 'N/A') {
                metadata[`${basePath}/bitrate`] = stream.bit_rate;
            }
            if (stream.avg_frame_rate && stream.avg_frame_rate !== '0/0') {
                metadata[`${basePath}/frameRate`] = stream.avg_frame_rate;
            }
            if (stream.tags?.rotate) metadata[`${basePath}/rotation`] = stream.tags.rotate;

            // Audio-specific
            if (stream.sample_rate) metadata[`${basePath}/sampleRate`] = stream.sample_rate;
            if (stream.channel_layout) metadata[`${basePath}/channelLayout`] = stream.channel_layout;
        }

        // Write to meta-core
        await metaCore.mergeMetadata(cid, metadata);

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

        await sendCallback({
            taskId: request.taskId,
            status: 'failed',
            duration,
            error: errorMessage,
        });
    }
}
