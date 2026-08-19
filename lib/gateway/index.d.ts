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
import { type ImageItem, type InboundEvent, type MessageItem, type SendResult, type WechatCredentials } from './types.ts';
export interface GatewayConfig {
    baseUrl?: string;
    cdnBaseUrl?: string;
    token?: string;
    accountId?: string;
    /**
     * H1: extra hostnames (besides ilinkai.weixin.qq.com / *.weixin.qq.com)
     * accepted by base-url validation. Exact hostname match, case-insensitive.
     */
    trustedBaseHosts?: string[];
    /**
     * F4: extra hostnames (besides novac2c.cdn.weixin.qq.com / *.cdn.weixin.qq.com)
     * accepted for CDN media download/upload URLs.
     */
    trustedMediaHosts?: string[];
}
export declare const Config: z<Schemastery.ObjectS<{
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
    trustedBaseHosts: z<string[], string[]>;
    trustedMediaHosts: z<string[], string[]>;
}>, Schemastery.ObjectT<{
    baseUrl: z<string, string>;
    cdnBaseUrl: z<string, string>;
    token: z<string, string>;
    accountId: z<string, string>;
    trustedBaseHosts: z<string[], string[]>;
    trustedMediaHosts: z<string[], string[]>;
}>>;
export type GatewayStatus = 'unauthenticated' | 'pairing' | 'polling' | 'paused' | 'stopped';
export interface LoginQrOptions {
    /**
     * QR payload: `scanData` is the scannable content (a URL from the server's
     * `qrcode_img_content` field — NOT the polling token), `pollToken` is the
     * hex token used for `get_qrcode_status` polling only.
     */
    onQr?: (qr: {
        scanData: string;
        pollToken: string;
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
/**
 * F5: log only the trailing 12 chars of a context token — the debug sinks
 * are plaintext JSONL under $DSH_HOME and must not carry full tokens.
 */
export declare function redactContextToken(token: string | null | undefined): string | null;
/**
 * F5: deep-copy the media-relevant layers of an inbound item (never mutate
 * the live object) and replace AES keys with '<redacted>' before any log or
 * capture sink sees them. Walks only the KNOWN layers — image/file/voice/
 * video items plus their media/thumb_media sub-objects — no full recursion.
 */
export declare function redactItemForCapture(item: MessageItem): MessageItem;
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
        /** A QR pairing was confirmed — the pairer's WeChat id is the trust anchor. */
        'wechat/paired'(payload: {
            userId: string;
            accountId: string | null;
        }): void;
        /**
         * A DIFFERENT account scanned the QR while another account is paired.
         * The gateway does NOT switch credentials — it awaits the panel's
         * confirmPairing() / rejectPairing() (C3/H4).
         */
        'wechat/pair-pending'(payload: {
            userId: string | null;
            accountId: string | null;
        }): void;
        /** The long-poll recovered after consecutive failures. */
        'wechat/back-online'(): void;
    }
}
export declare class WechatGateway extends Service {
    static Config: z<Schemastery.ObjectS<{
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
        trustedBaseHosts: z<string[], string[]>;
        trustedMediaHosts: z<string[], string[]>;
    }>, Schemastery.ObjectT<{
        baseUrl: z<string, string>;
        cdnBaseUrl: z<string, string>;
        token: z<string, string>;
        accountId: z<string, string>;
        trustedBaseHosts: z<string[], string[]>;
        trustedMediaHosts: z<string[], string[]>;
    }>>;
    /** Pull the credentials service in from sibling loader entries. */
    static inject: string[];
    status: GatewayStatus;
    readonly ctx: Context;
    private c;
    private stopPolling;
    private pollAbort;
    /** Durable inbound dedup — survives restart. */
    private seen;
    /** Durable get_updates_buf cursor, tagged with its bot identity. */
    private pollCursorStore;
    /** Last send failure facts for the status panel and outbox pause display. */
    lastSendError: {
        errcode?: number;
        errmsg?: string;
        at: number;
    } | null;
    /** Full stashed credentials of the pending pairing (kept private). */
    private pendingCreds;
    /**
     * C3: a pairing awaiting panel confirmation. Only the pairer's ids are
     * exposed — the full credentials stay private until confirmPairing().
     */
    get pendingPair(): {
        userId: string | null;
        accountId: string | null;
    } | null;
    private pollRunning;
    /** Bumped on every stop/start so a superseded loop exits promptly. */
    private pollGeneration;
    /** Lifetime promise of the current loop (its wrapper chain). */
    private pollLoopPromise;
    private typingTickets;
    private ticketRetryAt;
    private ticketBackoffMs;
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
    /**
     * C3: accept the pending pairing — persist the stashed credentials, stop
     * the old poll loop (abort + await full exit), then restart polling with
     * the new account through the unified entry.
     */
    confirmPairing(): Promise<boolean>;
    /** C3: reject the pending pairing — discard the stashed credentials. */
    rejectPairing(): boolean;
    /**
     * M2: unified polling entry — the ONLY place a poll loop is started. If a
     * loop is already running it is superseded (generation bump + in-flight
     * abort) and awaited to full exit before the fresh loop starts, so two
     * loops can never run concurrently, even across a credential switch.
     * Returns the new loop's lifetime promise (callers normally `void` it).
     */
    private startPollLoop;
    /** M2: stop the current loop and wait for its full exit (no replacement). */
    private stopPollLoop;
    /**
     * M2: in-loop sleep that resolves EARLY when the loop is superseded
     * (generation bumped by a stop/start) — a credential switch must not be
     * delayed by a pending 10-minute pause.
     */
    private pollSleep;
    private runPollLoop;
    private handleBatch;
    /** Download and decrypt an inbound image (M3: image-in-session). */
    downloadImage(item: ImageItem): Promise<{
        data: Buffer;
        ext: string;
    }>;
    /** Send one structured message item (text or bot progress card). */
    sendItem(params: {
        toUserId: string;
        item: MessageItem;
        contextToken?: string;
        runId?: string;
        creds?: WechatCredentials;
    }): Promise<SendResult>;
    /** Send a text message to a peer. Returns a structured result. */
    sendText(params: {
        toUserId: string;
        text: string;
        contextToken?: string;
        runId?: string;
        creds?: WechatCredentials;
    }): Promise<SendResult>;
    /**
     * Upload a local file to the WeChat CDN and send it as a message item.
     * Full pipeline per the official upload flow: getUploadUrl → AES-128-ECB →
     * CDN POST → sendMessage with the CDN reference. mediaType FILE or IMAGE.
     */
    private uploadAndSendMedia;
    /** Send a local file as a WeChat file attachment. */
    sendFile(params: {
        toUserId: string;
        filePath: string;
        fileName: string;
        contextToken?: string;
        runId?: string;
        creds?: WechatCredentials;
    }): Promise<SendResult>;
    /** Send a local video as a WeChat video message (type=5, verified 2026-08-17). */
    sendVideo(params: {
        toUserId: string;
        filePath: string;
        contextToken?: string;
        runId?: string;
        creds?: WechatCredentials;
    }): Promise<SendResult>;
    /** Send a local image as a WeChat image message (long-card pipeline). */
    sendImage(params: {
        toUserId: string;
        filePath: string;
        contextToken?: string;
        runId?: string;
        creds?: WechatCredentials;
    }): Promise<SendResult>;
    /**
     * Resolve a cached typing ticket (port of the official WeixinConfigManager:
     * 24h TTL, exponential backoff 2s→1h on failure), per-user like the
     * official per-account cache.
     */
    private resolveTypingTicket;
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