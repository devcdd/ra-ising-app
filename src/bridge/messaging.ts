/**
 * 네이티브 → 웹 송신 헬퍼 (N1, §2.6).
 * payload는 반드시 JSON.stringify로 직렬화(보간 금지 — XSS/문법오류 차단), 끝에 `true;`.
 */
import type { WebView } from 'react-native-webview';
import {
  ENVELOPE_VERSION,
  type BridgeEnvelope,
  type BridgeError,
  type EventEnvelope,
  type RpcResponseEnvelope,
} from './protocol';

export const nowTs = () => Date.now();

const deliver = (webView: WebView | null, envelope: BridgeEnvelope) => {
  if (!webView) {
    return;
  }
  // 웹 bridge 런타임(__RAISING_BRIDGE__)이 없으면(구버전 웹) no-op.
  const js = `window.__RAISING_BRIDGE__&&window.__RAISING_BRIDGE__.receive(${JSON.stringify(
    envelope,
  )});true;`;
  webView.injectJavaScript(js);
};

/** 단방향 이벤트 송신. */
export const postEvent = (
  webView: WebView | null,
  topic: string,
  payload?: unknown,
) => {
  const env: EventEnvelope = {
    v: ENVELOPE_VERSION,
    kind: 'event',
    topic,
    payload,
    ts: nowTs(),
  };
  deliver(webView, env);
};

/** rpc 성공 응답. */
export const postResponse = (
  webView: WebView | null,
  id: string,
  result: unknown,
) => {
  const env: RpcResponseEnvelope = {
    v: ENVELOPE_VERSION,
    kind: 'rpc.response',
    id,
    ok: true,
    result,
    ts: nowTs(),
  };
  deliver(webView, env);
};

/** rpc 실패 응답. */
export const postError = (
  webView: WebView | null,
  id: string,
  error: BridgeError,
) => {
  const env: RpcResponseEnvelope = {
    v: ENVELOPE_VERSION,
    kind: 'rpc.response',
    id,
    ok: false,
    error,
    ts: nowTs(),
  };
  deliver(webView, env);
};

/** geolocation 셰임(__RAISING_GEO__)에 직접 주입하는 raw JS 실행. */
export const injectRaw = (webView: WebView | null, js: string) => {
  webView?.injectJavaScript(`${js};true;`);
};
