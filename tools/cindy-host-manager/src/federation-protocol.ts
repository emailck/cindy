import { createHash } from 'node:crypto';
import { WebSocket } from 'ws';
import { ApiError } from './service.js';
export const FEDERATION_VERSION = 1;
export const LEASE_MS = 30_000;
export interface FederationNode { id: string; name: string; online: boolean; lastSeen: string | null }
export interface RpcResult { status: number; body: unknown }
export type Frame = Record<string, any>;
export function hash(value: string) { return createHash('sha256').update(value).digest('hex'); }
export function send(ws: WebSocket, frame: Frame) {
    if (ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 1_048_576) {
        ws.terminate();
        throw new ApiError(503, 'NODE_OFFLINE', 'Machine connection is unavailable.');
    }
    ws.send(JSON.stringify(frame));
}
export function parse(raw: { toString(): string }): Frame {
    const frame: unknown = JSON.parse(raw.toString());
    if (!frame || typeof frame !== 'object' || Array.isArray(frame) || typeof (frame as Frame).type !== 'string') throw new Error('Invalid frame');
    return frame as Frame;
}
export function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(value); }
export function centralUrl(origin: string): URL {
    const url = new URL(origin);
    if (url.origin !== origin || url.username || url.password || !(url.protocol === 'https:' || (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))))
        throw new ApiError(400, 'INVALID_CENTRAL', 'Use an HTTPS central origin (HTTP is allowed only on loopback).');
    return url;
}
const runtimeErrors: Record<string, [number, string]> = {
    STOP_TIMEOUT: [409, 'The process has not stopped. Data is retained; retry after it finishes.'],
    INSTANCE_RUNNING: [409, 'Stop the instance and finish any previous login before continuing.'],
    INSTANCE_STOPPED: [409, 'Start the instance before managing sharing.'],
    INSTANCE_MISSING: [409, 'Instance container is missing. Start it to recreate the container.'],
    RESOURCE_NOT_OWNED: [409, 'Docker resource ownership does not match this instance.'],
    PROXY_TEST_FAILED: [502, 'Proxy test failed. Check the address, authentication and connectivity.'],
    INVALID_PROXY: [400, 'Only HTTP CONNECT proxy URLs are supported.'],
    INVALID_SHARE: [400, 'Invalid share member, pairing code or setting.'],
    INVALID_LOGIN: [400, 'Invalid native login options.'],
    NATIVE_DIRECTORY_UNAVAILABLE: [409, 'The native configuration directory is unavailable. Check its ownership and permissions. Saved files are retained.'],
    GATEWAY_UNAVAILABLE: [409, 'Networks are not enabled on this computer. Set CINDY_MANAGER_GATEWAY_IMAGE.'],
    GATEWAY_IMAGE_MISSING: [409, 'The network gateway image is missing. Build it with scripts/build-gateway-image.sh.'],
    NETWORK_IN_USE: [409, 'Containers are still attached to this network.'],
    INVALID_NETWORK: [400, 'Invalid network configuration.'],
    NO_FREE_SUBNET: [409, 'No free network subnet is available.'],
    COMMAND_TIMEOUT: [504, 'The native command timed out.'],
    COMMAND_FAILED: [502, 'The native command failed. Check login and service availability.'],
    DOCKER_FAILED: [503, 'Docker is unavailable or the managed image could not run.'],
};
export function safeError(error: unknown): RpcResult {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    const mapped = runtimeErrors[code];
    const safe = error instanceof ApiError ? error : mapped ? new ApiError(mapped[0], code, mapped[1]) : new ApiError(500, 'OPERATION_FAILED', 'Operation failed. Check the host configuration and try again.');
    return { status: safe.status, body: { error: { code: safe.code, message: safe.message } } };
}
