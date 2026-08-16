window.__ModuleLoader__.load({
	id: "dsh-wechat-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		var { createElement: createElement, useEffect: useEffect, useState: useState } = require("react");

		//#region src/client.ts
		const NS = "settings.dshWechatBridge";
		const zh = {
			tab: "微信桥",
			title: "微信控制 DSH",
			paired: "已配对",
			unpaired: "未配对",
			gatewayStatus: "网关状态",
			accountId: "账号 ID",
			allowFrom: "白名单（allowFrom）",
			modes: "可用模式",
			defaultMode: "默认模式",
			prefs: "桥内偏好（对 /new 生效）",
			prefsModel: "模型",
			prefsCwd: "工作区",
			prefsDefault: "跟随 DSH 默认",
			markdownMode: "Markdown 策略",
			outbox: "出站队列",
			outboxPending: "{n} 条待发",
			outboxPaused: "限流暂停中",
			outboxIdle: "空闲",
			pair: "扫码配对",
			pairing: "配对中…请用微信扫码",
			pairHint: "二维码 5 分钟过期，过期会自动刷新。",
			emptyAllowlist: "（空——需在 profile 配置中填写 allowFrom 才会应答消息）",
			helpTitle: "微信命令",
			help: [
				"/modes — 全部模式（中文说明 + 编号快捷）",
				"/new [模式] <prompt> — 新建会话",
				"/model · /workspace — 切换模型/工作区",
				"/use N / /sessions / /stop / /status",
				"/retry / /close / /help — 重试 / 归档 / 帮助",
				"/yes /no — 回应权限请求"
			].join("\n"),
			requestFailed: "状态读取失败"
		};
		const en = {
			tab: "WeChat Bridge",
			title: "Control DSH from WeChat",
			paired: "Paired",
			unpaired: "Not paired",
			gatewayStatus: "Gateway status",
			accountId: "Account ID",
			allowFrom: "Allowlist (allowFrom)",
			modes: "Available modes",
			defaultMode: "Default mode",
			prefs: "Bridge prefs (apply to /new)",
			prefsModel: "Model",
			prefsCwd: "Workspace",
			prefsDefault: "Follow DSH default",
			markdownMode: "Markdown policy",
			outbox: "Outbound queue",
			outboxPending: "{n} pending",
			outboxPaused: "Rate-limit pause",
			outboxIdle: "Idle",
			pair: "Pair via QR",
			pairing: "Pairing… scan with WeChat",
			pairHint: "The QR expires after 5 minutes and refreshes automatically.",
			emptyAllowlist: "(empty — fill allowFrom in the profile config to accept messages)",
			helpTitle: "WeChat commands",
			help: [
				"/modes — all modes (annotated + numbered)",
				"/new [mode] <prompt> — create a session",
				"/model · /workspace — switch model/workspace",
				"/use N / /sessions / /stop / /status",
				"/retry / /close / /help — retry / archive / help",
				"/yes /no — answer permission requests"
			].join("\n"),
			requestFailed: "Failed to load status"
		};
		function useStatus() {
			const [status, setStatus] = useState(null);
			const load = async () => {
				try {
					setStatus(await (await fetch("/api/dsh-wechat-bridge/status")).json());
				} catch {}
			};
			useEffect(() => {
				load();
				const timer = setInterval(() => void load(), 3e3);
				return () => clearInterval(timer);
			}, []);
			return {
				status,
				refresh: load
			};
		}
		const css = {
			section: {
				width: "100%",
				maxWidth: 760,
				display: "flex",
				flexDirection: "column",
				gap: 14,
				color: "var(--dsw-alias-label-primary)",
				fontFamily: "inherit"
			},
			row: {
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				gap: 12
			},
			title: {
				margin: 0,
				fontSize: 15,
				lineHeight: "22px"
			},
			card: {
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 10,
				background: "var(--dsw-alias-bg-layer-2)",
				padding: "12px 14px",
				display: "flex",
				flexDirection: "column",
				gap: 8
			},
			muted: {
				margin: 0,
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 13,
				lineHeight: "20px"
			},
			label: {
				color: "var(--dsw-alias-label-tertiary)",
				fontSize: 12
			},
			value: {
				margin: 0,
				fontSize: 13,
				wordBreak: "break-all"
			},
			pill: {
				display: "inline-flex",
				borderRadius: 999,
				padding: "2px 10px",
				fontSize: 12,
				background: "color-mix(in srgb, var(--dsw-alias-state-success-primary) 14%, transparent)",
				color: "var(--dsw-alias-state-success-primary)",
				width: "max-content"
			},
			pillError: {
				display: "inline-flex",
				borderRadius: 999,
				padding: "2px 10px",
				fontSize: 12,
				background: "color-mix(in srgb, var(--dsw-alias-state-error-primary) 14%, transparent)",
				color: "var(--dsw-alias-state-error-primary)",
				width: "max-content"
			},
			chip: {
				display: "inline-block",
				borderRadius: 6,
				padding: "3px 8px",
				fontSize: 12,
				border: "1px solid var(--dsw-alias-border-l2)",
				background: "var(--dsw-alias-bg-layer-1)",
				margin: "2px 4px 2px 0"
			},
			button: {
				height: 36,
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 8,
				background: "var(--dsw-alias-bg-layer-2)",
				color: "var(--dsw-alias-label-primary)",
				font: "inherit",
				padding: "0 12px",
				cursor: "pointer"
			},
			qr: {
				width: 240,
				height: 240,
				border: "1px solid var(--dsw-alias-border-l2)",
				borderRadius: 10
			},
			pre: {
				margin: 0,
				fontSize: 12,
				lineHeight: "20px",
				color: "var(--dsw-alias-label-tertiary)",
				whiteSpace: "pre-wrap"
			},
			error: {
				margin: 0,
				color: "var(--dsw-alias-state-error-primary)",
				fontSize: 13
			}
		};
		function WechatBridgePanel(props) {
			const { t } = props;
			const { status } = useStatus();
			const [qr, setQr] = useState(null);
			const [pairing, setPairing] = useState(false);
			const [error, setError] = useState(null);
			const pair = async () => {
				setError(null);
				setPairing(true);
				try {
					const data = await (await fetch("/api/dsh-wechat-bridge/pair", { method: "POST" })).json();
					if (!data.ok || !data.svg) throw new Error(data.error ?? "pair failed");
					setQr(data.svg);
				} catch (err) {
					setError(String(err));
					setPairing(false);
				}
			};
			const svgDataUrl = qr ? `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(qr)))}` : null;
			return createElement("section", { style: css.section }, createElement("div", { style: css.row }, createElement("h3", { style: css.title }, t("title")), status?.paired ? createElement("span", { style: css.pill }, t("paired")) : createElement("span", { style: css.pillError }, t("unpaired"))), createElement("div", { style: css.card }, createElement("div", null, createElement("span", { style: css.label }, `${t("gatewayStatus")} · ${status?.status ?? "…"}`), status?.pairingMessage ? createElement("p", { style: css.muted }, status.pairingMessage) : null), createElement("div", null, createElement("span", { style: css.label }, t("accountId")), createElement("p", { style: css.value }, status?.accountId ?? "—")), createElement("div", null, createElement("span", { style: css.label }, t("allowFrom")), createElement("div", null, (status?.allowFrom ?? []).length > 0 ? status.allowFrom.map((id) => createElement("span", {
				key: id,
				style: css.chip
			}, id)) : createElement("p", { style: css.muted }, t("emptyAllowlist")))), createElement("div", null, createElement("span", { style: css.label }, `${t("modes")}${status?.defaultMode ? ` · ${t("defaultMode")}: ${status.defaultMode}` : ""}`), createElement("div", null, (status?.modes ?? []).length > 0 ? status.modes.map((mode) => createElement("span", {
				key: mode.id,
				style: css.chip,
				title: mode.description ?? void 0
			}, mode.name && mode.name !== mode.id ? `${mode.name}（${mode.id}）` : mode.id)) : createElement("p", { style: css.muted }, "—"))), createElement("div", null, createElement("span", { style: css.label }, `${t("prefs")} · ${t("markdownMode")}: ${status?.markdownMode ?? "…"}`), createElement("p", { style: css.muted }, `${t("prefsModel")}: ${status?.prefs.provider && status.prefs.model ? `${status.prefs.provider}/${status.prefs.model}` : t("prefsDefault")} · ${t("prefsCwd")}: ${status?.prefs.cwd ?? t("prefsDefault")}`)), createElement("div", null, createElement("span", { style: css.label }, t("outbox")), createElement("p", { style: css.muted }, status?.outbox.pausedUntil ? `${t("outboxPaused")}（${Math.max(1, Math.round((status.outbox.pausedUntil - Date.now()) / 1e3))}s）` : status?.outbox.pending ? t("outboxPending").replace("{n}", String(status.outbox.pending)) : t("outboxIdle"))), status?.lastSendError ? createElement("p", { style: css.muted }, `⚠ ${t("requestFailed")}: errcode=${status.lastSendError.errcode ?? "-"} ${status.lastSendError.errmsg ?? ""}`) : null), createElement("div", { style: css.card }, createElement("div", { style: css.row }, createElement("h4", { style: css.title }, t("pair")), createElement("button", {
				style: css.button,
				onClick: () => void pair(),
				disabled: pairing
			}, pairing ? t("pairing") : t("pair"))), svgDataUrl ? createElement("img", {
				src: svgDataUrl,
				style: css.qr,
				alt: "WeChat QR"
			}) : null, createElement("p", { style: css.muted }, t("pairHint")), error ? createElement("p", { style: css.error }, `${t("requestFailed")}: ${error}`) : null), createElement("div", { style: css.card }, createElement("h4", { style: css.title }, t("helpTitle")), createElement("pre", { style: css.pre }, t("help"))));
		}
		const inject = ["slots", "locale"];
		function apply(ctx) {
			ctx.effect(() => {
				return ctx.locale.register(NS, {
					zh,
					en
				});
			});
			const t = ctx.locale.bind(NS);
			ctx.slots.inject("settings.plugins.tab", () => ctx.slots.register({
				name: "settings.plugins.tab",
				id: "dsh-wechat-bridge",
				order: 30,
				label: () => t("tab"),
				locale: NS,
				inject: () => ({ t })
			}, WechatBridgePanel));
		}

		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
