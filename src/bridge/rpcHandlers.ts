/**
 * 무상태 RPC capability 핸들러 맵 (N8/N13/N14/N16 + system/permissions).
 * 각 핸들러는 result를 resolve하거나 BridgeError 형태로 throw한다(디스패처가 postError).
 * geo.*(N5)는 watch 상태를 가져 App.tsx에서 처리한다.
 */
import { Linking, PermissionsAndroid, Platform, Share } from 'react-native';
import Clipboard from '@react-native-clipboard/clipboard';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NetInfo from '@react-native-community/netinfo';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';
import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeMethods,
  type BridgeError,
  type Insets,
} from './protocol';

export interface RpcContext {
  appVersion: string;
  capabilities: string[];
  getInsets: () => Insets;
}

const fail = (code: BridgeError['code'], message?: string): never => {
  const err: BridgeError = { code, message };
  throw err;
};

const HAPTIC_OPTS = {
  enableVibrateFallback: true,
  ignoreAndroidSystemSettings: false,
};

const permissionStatus = async (name: unknown, request: boolean) => {
  // OS별 권한 추상화는 1차에선 Android location만 실동작. 그 외는 unavailable로 두어
  // 웹이 직접 처리/폴백하게 한다(geo는 navigator.geolocation 셰임이 별도 담당).
  if (name === 'location' && Platform.OS === 'android') {
    const perm = PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
    if (request) {
      const r = await PermissionsAndroid.request(perm);
      return { status: r === PermissionsAndroid.RESULTS.GRANTED ? 'granted' : 'denied' };
    }
    const ok = await PermissionsAndroid.check(perm);
    return { status: ok ? 'granted' : 'denied' };
  }
  return { status: 'unavailable' };
};

export const createRpcHandlers = (
  ctx: RpcContext,
): Record<string, (params: any) => Promise<unknown>> => ({
  [BridgeMethods.systemGetInfo]: async () => ({
    platform: Platform.OS,
    appVersion: ctx.appVersion,
    bridgeProtocol: BRIDGE_PROTOCOL_VERSION,
    insets: ctx.getInsets(),
    capabilities: ctx.capabilities,
  }),

  [BridgeMethods.netGetStatus]: async () => {
    const state = await NetInfo.fetch();
    return { isConnected: Boolean(state.isConnected), type: state.type };
  },

  [BridgeMethods.hapticImpact]: async (p) => {
    const style =
      p?.style === 'heavy'
        ? 'impactHeavy'
        : p?.style === 'medium'
          ? 'impactMedium'
          : 'impactLight';
    ReactNativeHapticFeedback.trigger(style, HAPTIC_OPTS);
    return { ok: true };
  },
  [BridgeMethods.hapticNotification]: async (p) => {
    const type =
      p?.type === 'warning'
        ? 'notificationWarning'
        : p?.type === 'error'
          ? 'notificationError'
          : 'notificationSuccess';
    ReactNativeHapticFeedback.trigger(type, HAPTIC_OPTS);
    return { ok: true };
  },
  [BridgeMethods.hapticSelection]: async () => {
    ReactNativeHapticFeedback.trigger('selection', HAPTIC_OPTS);
    return { ok: true };
  },

  [BridgeMethods.shareOpen]: async (p) => {
    const message = [p?.text, p?.url].filter(Boolean).join('\n');
    if (!message) {
      fail('E_INVALID_PARAMS', 'share: url 또는 text가 필요합니다');
    }
    const result = await Share.share(
      p?.url
        ? { message, title: p?.title, url: p.url }
        : { message, title: p?.title },
    );
    return {
      ok: result.action !== Share.dismissedAction,
      dismissed: result.action === Share.dismissedAction,
    };
  },

  [BridgeMethods.openURL]: async (p) => {
    const url = String(p?.url ?? '');
    const scheme = (url.split(':')[0] || '').toLowerCase();
    // 스킴 화이트리스트 — javascript:/file: 등 위험 스킴 차단.
    if (!url || scheme === 'javascript' || scheme === 'file' || scheme === 'data') {
      fail('E_INVALID_PARAMS', `허용되지 않은 URL: ${url}`);
    }
    try {
      await Linking.openURL(url);
      return { ok: true };
    } catch (e) {
      return fail('E_NATIVE', `openURL 실패: ${String((e as Error)?.message ?? e)}`);
    }
  },

  [BridgeMethods.clipboardWrite]: async (p) => {
    Clipboard.setString(String(p?.text ?? ''));
    return { ok: true };
  },
  [BridgeMethods.clipboardRead]: async () => ({ text: await Clipboard.getString() }),

  [BridgeMethods.storageGet]: async (p) => ({
    value: await AsyncStorage.getItem(String(p?.key)),
  }),
  [BridgeMethods.storageSet]: async (p) => {
    await AsyncStorage.setItem(String(p?.key), String(p?.value ?? ''));
    return { ok: true };
  },
  [BridgeMethods.storageRemove]: async (p) => {
    await AsyncStorage.removeItem(String(p?.key));
    return { ok: true };
  },

  [BridgeMethods.permissionsQuery]: async (p) => permissionStatus(p?.name, false),
  [BridgeMethods.permissionsRequest]: async (p) => permissionStatus(p?.name, true),
});
