/**
 * wechat-gateway plugin: the iLink gateway as a Cordis service (`ctx.wechat`).
 *
 * Owns: QR login (loginQr), authenticated long-poll loop with reconnect
 * backoff, inbound dedup, send retry, the typing indicator, and credential
 * resolution (config fallback + dsh-credentials service). Emits scoped
 * `inbound` events consumed by the conversation node.
 *
 * Protocol client derived from Tencent/openclaw-weixin (MIT).
 *
 * @module dsh-wechat-bridge/gateway
 */
import { Context, Service } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type QrLoginStatus } from './ilink-client.ts';
import { type ImageItem, type InboundEvent, type WechatCredentials } from './types.ts';
export interface GatewayConfig {
    baseUrl?: string;
    cdnBaseUrl?: string;
    token?: string;
    accountId?: string;
}
export declare const Config: z<Schemastery.ObjectS<{
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
}>, Schemastery.ObjectT<{
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
}>>;
export type GatewayStatus = 'unauthenticated' | 'pairing' | 'polling' | 'paused' | 'stopped';
export interface LoginQrOptions {
    onQr?: (qr: {
        scanData: string;
        imgContent?: string;
    }) => void;
    onStatus?: (status: QrLoginStatus | string) => void;
    botType?: string;
    /** Overall login timeout (ms). Default 5 minutes. */
    timeoutMs?: number;
    /** Poll interval for QR status (ms). Default 1500. */
    qrPollIntervalMs?: number;
}
export interface LoginQrResult {
    success: boolean;
    credentials?: WechatCredentials;
    message: string;
}
export interface ResolvedGatewayConfig extends Required<GatewayConfig> {
}
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** The iLink gateway service provided by the wechat-gateway plugin. */
        wechat: WechatGateway;
    }
    interface Events {
        /** One inbound iLink message, deduplicated at the gateway. */
        'wechat/message'(payload: InboundEvent): void;
        /** Gateway connection status changed. */
        'wechat/status'(status: GatewayStatus): void;
    }
}
export declare class WechatGateway extends Service {
    static Config: z<Schemastery.ObjectS<{
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
    }>, Schemastery.ObjectT<{
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
    }>>;
    status: GatewayStatus;
    readonly ctx: Context;
    private c;
    private stopPolling;
    private pollAbort;
    private seenMsgIds;
    constructor(ctx: Context, config: GatewayConfig);
    /** Resolve credentials: explicit config first, then the credentials service. */
    resolveCredentials(): Promise<WechatCredentials | null>;
    private boot;
    /** Persist credentials through the dsh credentials service. */
    saveCredentials(creds: WechatCredentials): Promise<void>;
    /** Shared QR pairing loop used by both the CLI login and the settings panel. */
    private runPairing;
    /**
     * Run the iLink QR login flow. On success returns the credentials; the
     * caller persists them (e.g. via the credentials service).
     */
    loginQr(opts?: LoginQrOptions): Promise<LoginQrResult>;
    /** Pairing state surfaced to the Web settings panel. */
    pairingQr: {
        scanData: string;
        svg: string;
    } | null;
    pairingMessage: string;
    /**
     * Start a pairing from the Web settings panel: renders the QR as SVG,
     * auto-refreshes on expiry, and persists credentials on confirm.
     */
    startPairing(): Promise<{
        svg: string;
        scanData: string;
    }>;
    private pollLoop;
    private handleBatch;
    /** Download and decrypt an inbound image (M3: image-in-session). */
    downloadImage(item: ImageItem): Promise<{
        data: Buffer;
        ext: string;
    }>;
    /** Send a text message to a peer. Returns true on success. */
    sendText(params: {
        toUserId: string;
        text: string;
        contextToken?: string;
        creds?: WechatCredentials;
    }): Promise<boolean>;
    /** Send a typing indicator (1 = typing, 2 = cancel). */
    sendTypingIndicator(params: {
        toUserId: string;
        status: 1 | 2;
        contextToken?: string;
        creds?: WechatCredentials;
    }): Promise<void>;
}
export default WechatGateway;
//# sourceMappingURL=index.d.ts.map