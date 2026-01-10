/**
 * MetaMesh Plugin: ffmpeg
 * Entry point
 */

import Fastify from 'fastify';
import type {
    HealthResponse,
    ProcessRequest,
    ProcessResponse,
    CallbackPayload,
    ConfigureRequest,
    ConfigureResponse,
} from './types.js';
import { manifest, process as processFile } from './plugin.js';

const app = Fastify({ logger: true });
let ready = false;
let pluginConfig: Record<string, unknown> = {};

app.get('/health', async (): Promise<HealthResponse> => ({
    status: 'healthy',
    ready,
    version: manifest.version,
}));

app.get('/manifest', async () => manifest);

app.post<{ Body: ConfigureRequest }>('/configure', async (request): Promise<ConfigureResponse> => {
    try {
        pluginConfig = request.body.config || {};
        console.log('[ffmpeg] Configuration updated');
        return { status: 'ok' };
    } catch (error) {
        return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
});

app.post<{ Body: ProcessRequest }>('/process', async (request, reply) => {
    const { taskId, cid, filePath, callbackUrl, metaCoreUrl } = request.body;

    if (!taskId || !cid || !filePath || !callbackUrl || !metaCoreUrl) {
        return reply.send({ status: 'rejected', error: 'Missing required fields' } as ProcessResponse);
    }

    processFile(request.body, async (payload: CallbackPayload) => {
        try {
            await fetch(callbackUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            });
        } catch (error) {
            console.error('[ffmpeg] Callback error:', error);
        }
    }).catch(console.error);

    return reply.send({ status: 'accepted' } as ProcessResponse);
});

const port = parseInt(process.env.PORT || '8080', 10);
const host = process.env.HOST || '0.0.0.0';

app.listen({ port, host }).then(() => {
    ready = true;
    console.log(`[ffmpeg] Plugin listening on http://${host}:${port}`);
});

process.on('SIGTERM', async () => {
    ready = false;
    await app.close();
    process.exit(0);
});
