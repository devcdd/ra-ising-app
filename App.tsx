/**
 * WebView 셸 + 네이티브 브리지 (라이징 네이티브 전환).
 * 단일 WebView + 형제 네이티브 탭바(D1) + 버전드 RPC 브리지(§2). 설계: 라이징 앱 네이티브 전환 개발 계획서.
 *
 * @format
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AppState,
  Alert,
  BackHandler,
  Keyboard,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
  useColorScheme,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import Geolocation from '@react-native-community/geolocation';
import SplashScreen from 'react-native-splash-screen';
import NetInfo from '@react-native-community/netinfo';
import LottieView from 'lottie-react-native';

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeMethods,
  BridgeTopics,
  isEnvelope,
  type BridgeError,
  type Insets,
  type RaisingAppGlobal,
  type RpcRequestEnvelope,
  type StatusBarStyle,
  type ActiveTab,
} from './src/bridge/protocol';
import { injectRaw, postError, postEvent, postResponse } from './src/bridge/messaging';
import { buildBootstrapJs } from './src/bridge/injectedJs';
import { createRpcHandlers } from './src/bridge/rpcHandlers';
import NativeTabBar, { TAB_BAR_HEIGHT } from './src/components/NativeTabBar';

// 프로덕션 웹 오리진 (스토어/릴리스 빌드는 항상 이걸 로드).
const PROD_WEB_URL = 'https://ra-ising.com';
// 로컬 vite dev 서버 포트 (raising-client: vite `host: true` → :5173).
const DEV_WEB_PORT = 5173;

/**
 * dev 빌드에서는 로컬 vite 서버를, 그 외엔 프로덕션을 로드한다.
 * Metro 번들 URL(scriptURL)에서 dev 머신 host만 떼어 포트를 5173으로 바꾸므로
 * iOS 시뮬레이터(localhost)·Android 에뮬레이터(10.0.2.2)·실기기(LAN IP)에
 * 별도 설정 없이 자동 대응한다. 추출 실패 시 프로덕션으로 폴백.
 */
function resolveWebUrl(): string {
  if (!__DEV__) {
    return PROD_WEB_URL;
  }
  const scriptURL: string | undefined = (NativeModules.SourceCode as any)
    ?.scriptURL;
  const host = scriptURL?.split('://')[1]?.split(/[:/]/)[0];
  return host ? `http://${host}:${DEV_WEB_PORT}` : PROD_WEB_URL;
}

const WEB_URL = resolveWebUrl();

if (__DEV__) {
  console.log('[dev] WebView source =', WEB_URL);
}

// 스토어 버전. 추후 react-native-device-info로 네이티브 값과 동기화 권장(N2 [확인 필요]).
const APP_VERSION = '1.0.0';

// 1차 빌드 capability 화이트리스트 (§2.8.2). push.*/imagePicker.*/camera.*는 외부 의존이라 제외 → 웹 has()=false 자동 폴백.
const CAPABILITIES = Object.values(BridgeMethods).filter(
  (m) =>
    !m.startsWith('push.') &&
    !m.startsWith('imagePicker.') &&
    !m.startsWith('camera.'),
);

// openURL 하위 협상 스킴(§2.8.1). iOS LSApplicationQueriesSchemes와 일치시킬 것.
const OPEN_URL_SCHEMES = ['tel', 'mailto', 'nmap', 'kakaomap', 'itms-apps', 'app-settings'];

// 기존 가짜 Safari UA에 앱 식별 토큰 추가(N2b). 서버/GTM은 `RaisingApp/`로 판별.
const BASE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const insets = useSafeAreaInsets();

  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isConnected, setIsConnected] = useState(true);
  const [appState, setAppState] = useState(AppState.currentState);

  // 브리지 상태
  const [activeTab, setActiveTab] = useState<ActiveTab | null>('home'); // ROUTE_CHANGED(웹 소유)로 갱신
  const [topCollapsed, setTopCollapsed] = useState(false); // 지도 풀블리드(SET_SAFE_AREA_MODE edge-to-edge top)
  const [statusBarStyle, setStatusBarStyle] = useState<StatusBarStyle | null>(null);
  const [statusBarBg, setStatusBarBg] = useState<string | undefined>(undefined);

  const webViewRef = useRef<WebView>(null);
  const geoWatches = useRef<Map<string, number>>(new Map()); // externalId → native watchId
  const backCanHandle = useRef(false); // G5: 웹이 push한 "back 처리 가능" 상태 미러
  const splashHidden = useRef(false);

  const rawInsets: Insets = useMemo(
    () => ({
      top: insets.top,
      bottom: insets.bottom,
      left: insets.left,
      right: insets.right,
    }),
    [insets.top, insets.bottom, insets.left, insets.right],
  );

  const rpcHandlers = useMemo(
    () =>
      createRpcHandlers({
        appVersion: APP_VERSION,
        capabilities: CAPABILITIES,
        getInsets: () => rawInsets,
      }),
    [rawInsets],
  );

  // __RAISING_APP__ 핸드셰이크 객체(N2) → injectedJavaScriptBeforeContentLoaded.
  const bootstrapJs = useMemo(() => {
    const appGlobal: RaisingAppGlobal = {
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      appVersion: APP_VERSION,
      bridgeProtocol: BRIDGE_PROTOCOL_VERSION,
      insets: rawInsets, // raw 부트스트랩값. 적용은 SAFE_AREA_INSETS(잔여) 이벤트로 갱신(§2.7.1)
      tabBar: { native: true, height: TAB_BAR_HEIGHT },
      capabilities: CAPABILITIES,
      openURLSchemes: OPEN_URL_SCHEMES,
    };
    return buildBootstrapJs(appGlobal);
  }, [rawInsets]);

  const emit = useCallback(
    (topic: string, payload?: unknown) => postEvent(webViewRef.current, topic, payload),
    [],
  );

  // 잔여 인셋 송신(§2.7.1): top은 풀블리드일 때만 실값, bottom은 네이티브 탭바가 처리하므로 0.
  const emitSafeAreaInsets = useCallback(() => {
    emit(BridgeTopics.safeAreaInsets, {
      insets: { top: topCollapsed ? insets.top : 0, bottom: 0, left: 0, right: 0 },
    });
  }, [emit, topCollapsed, insets.top]);

  // ---- geolocation (N5) — navigator.geolocation 셰임(GEO_*) + 형식 RPC 둘 다 지원 ----
  const geoCall = useCallback(
    (fn: 'resolve' | 'reject' | 'update' | 'fail', id: string, arg: object) =>
      injectRaw(
        webViewRef.current,
        `window.__RAISING_GEO__&&window.__RAISING_GEO__.${fn}(${JSON.stringify(id)},${JSON.stringify(arg)})`,
      ),
    [],
  );

  const stopWatch = useCallback((externalId: string) => {
    const nativeId = geoWatches.current.get(externalId);
    if (nativeId != null) {
      Geolocation.clearWatch(nativeId);
      geoWatches.current.delete(externalId);
    }
  }, []);

  const handleGeoShim = useCallback(
    (type: string, id: string, options: any) => {
      if (type === 'GEO_GET_CURRENT') {
        Geolocation.getCurrentPosition(
          (pos) =>
            geoCall('resolve', id, {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            }),
          (err) => geoCall('reject', id, { code: err.code, message: err.message }),
          {
            enableHighAccuracy: options?.enableHighAccuracy ?? true,
            timeout: options?.timeout ?? 15000,
            maximumAge: options?.maximumAge ?? 10000,
          },
        );
      } else if (type === 'GEO_WATCH') {
        const nativeId = Geolocation.watchPosition(
          (pos) =>
            geoCall('update', id, {
              latitude: pos.coords.latitude,
              longitude: pos.coords.longitude,
              accuracy: pos.coords.accuracy,
            }),
          (err) => geoCall('fail', id, { code: err.code, message: err.message }),
          { enableHighAccuracy: options?.enableHighAccuracy ?? true, distanceFilter: 0 },
        );
        geoWatches.current.set(id, nativeId);
      } else if (type === 'GEO_CLEAR_WATCH') {
        stopWatch(id);
      }
    },
    [geoCall, stopWatch],
  );

  // ---- 형식 RPC 디스패처 (N1) ----
  const handleRpcRequest = useCallback(
    async (req: RpcRequestEnvelope) => {
      const wv = webViewRef.current;
      const params: any = req.params;
      try {
        if (req.method === BridgeMethods.geoGetCurrent) {
          Geolocation.getCurrentPosition(
            (pos) =>
              postResponse(wv, req.id, {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
              }),
            (err) =>
              postError(wv, req.id, {
                code: err.code === 1 ? 'E_PERMISSION_DENIED' : 'E_NATIVE',
                message: err.message,
              }),
            {
              enableHighAccuracy: params?.enableHighAccuracy ?? true,
              timeout: params?.timeout ?? 15000,
              maximumAge: params?.maximumAge ?? 10000,
            },
          );
          return;
        }
        if (req.method === BridgeMethods.geoWatch) {
          const nativeId = Geolocation.watchPosition(
            (pos) =>
              emit(BridgeTopics.geoWatchUpdate, {
                watchId: req.id,
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
              }),
            () => {},
            { enableHighAccuracy: params?.enableHighAccuracy ?? true, distanceFilter: 0 },
          );
          geoWatches.current.set(req.id, nativeId);
          postResponse(wv, req.id, { watchId: req.id });
          return;
        }
        if (req.method === BridgeMethods.geoClearWatch) {
          stopWatch(String(params?.watchId));
          postResponse(wv, req.id, { ok: true });
          return;
        }

        const handler = rpcHandlers[req.method];
        if (!handler) {
          postError(wv, req.id, {
            code: 'E_UNSUPPORTED',
            message: `미지원 method: ${req.method}`,
          });
          return;
        }
        const result = await handler(params);
        postResponse(wv, req.id, result);
      } catch (e) {
        const err: BridgeError =
          e && typeof e === 'object' && 'code' in e
            ? (e as BridgeError)
            : { code: 'E_NATIVE', message: String((e as Error)?.message ?? e) };
        postError(wv, req.id, err);
      }
    },
    [emit, rpcHandlers, stopWatch],
  );

  // ---- 웹→네이티브 이벤트 ----
  const handleWebEvent = useCallback((topic: string, payload: any) => {
    switch (topic) {
      case BridgeTopics.routeChanged: // 하이라이트만 갱신(NAVIGATE 재발신 금지, §2.9.2)
        setActiveTab((payload?.activeTab as ActiveTab) ?? null);
        break;
      case BridgeTopics.setSafeAreaMode: // 멱등(§2.7.1)
        setTopCollapsed(
          payload?.mode === 'edge-to-edge' &&
            Array.isArray(payload?.edges) &&
            payload.edges.includes('top'),
        );
        break;
      case BridgeTopics.setStatusBar:
        setStatusBarStyle((payload?.style as StatusBarStyle) ?? null);
        setStatusBarBg(payload?.backgroundColor);
        break;
      case BridgeTopics.backState: // G5: 웹이 back 처리 가능 여부를 선제 push
        backCanHandle.current = Boolean(payload?.canHandle);
        break;
      default:
        break;
    }
  }, []);

  const handleWebViewMessage = useCallback(
    (event: WebViewMessageEvent) => {
      let data: any;
      try {
        data = JSON.parse(event.nativeEvent.data);
      } catch {
        return;
      }
      // 1) geolocation 셰임 메시지(GEO_*)
      if (data?.type === 'GEO_GET_CURRENT' || data?.type === 'GEO_WATCH' || data?.type === 'GEO_CLEAR_WATCH') {
        handleGeoShim(data.type, String(data.id), data.options);
        return;
      }
      // 2) 형식 봉투
      if (isEnvelope(data)) {
        if (data.kind === 'rpc.request') {
          // 내부에서 모든 에러를 catch하므로 floating이어도 안전.
          handleRpcRequest(data);
        } else if (data.kind === 'event') {
          handleWebEvent(data.topic, data.payload);
        }
      }
    },
    [handleGeoShim, handleRpcRequest, handleWebEvent],
  );

  // ---- 탭 터치(N4) → NAVIGATE 발신. 재탭이면 scroll.top도(§2.9.2 재탭 단순화안) ----
  const handleTabPress = useCallback(
    (tab: ActiveTab, path: string) => {
      emit(BridgeTopics.navigate, { tab, path });
      if (tab === activeTab) {
        emit(BridgeTopics.scrollTop);
      }
    },
    [activeTab, emit],
  );

  // ---- 초기 위치 권한 요청(기존 UX 유지) ----
  useEffect(() => {
    Geolocation.getCurrentPosition(
      () => {},
      () => {
        Alert.alert(
          '위치 권한 필요',
          '이 앱은 위치 기반 서비스를 제공하기 위해 위치 정보가 필요합니다. 설정에서 위치 권한을 허용해주세요.',
          [{ text: '확인' }],
        );
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 300000 },
    );
  }, []);

  // ---- 네트워크(N16) ----
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener((state) => {
      const connected = state.isConnected ?? false;
      setIsConnected(connected);
      if (connected && hasError) {
        setHasError(false);
      }
      emit(BridgeTopics.netStatus, { isConnected: connected, type: state.type });
    });
    return () => unsubscribe();
  }, [emit, hasError]);

  // ---- 앱 라이프사이클(N15) ----
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next) => {
      if (appState.match(/inactive|background/) && next === 'active') {
        setHasError(false);
      }
      setAppState(next);
      emit(BridgeTopics.appLifecycle, { state: next });
    });
    return () => sub.remove();
  }, [appState, emit]);

  // ---- 키보드(N9) — adjustResize 유지 정책(G3, 잠정). 웹은 height 방어적 소비 ----
  useEffect(() => {
    const showEvt = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvt = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const onShow = (e: any) =>
      emit(BridgeTopics.keyboard, {
        height: e?.endCoordinates?.height ?? 0,
        duration: e?.duration ?? 0,
      });
    const onHide = (e: any) =>
      emit(BridgeTopics.keyboard, { height: 0, duration: e?.duration ?? 0 });
    const s1 = Keyboard.addListener(showEvt, onShow);
    const s2 = Keyboard.addListener(hideEvt, onHide);
    return () => {
      s1.remove();
      s2.remove();
    };
  }, [emit]);

  // ---- 백버튼 위임(N11, Android, G5) ----
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const onBack = () => {
      if (backCanHandle.current) {
        emit(BridgeTopics.androidBackPress);
        return true; // 웹이 처리(모달 닫기 등) → 기본 동작 차단
      }
      return false; // 미처리 → 기본 동작(뒤로/종료)
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [emit]);

  // ---- 인셋 변화/모드 변화 시 잔여 인셋 송신(N6/N7) ----
  useEffect(() => {
    emitSafeAreaInsets();
  }, [emitSafeAreaInsets]);

  const handleWebViewLoadEnd = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
    if (!splashHidden.current) {
      splashHidden.current = true;
      SplashScreen.hide(); // R-E: 첫 페인트에 스플래시 해제(FOUC 가림)
    }
    emitSafeAreaInsets(); // 웹 bridge 준비 후 재송신(초기 드롭 보정)
  }, [emitSafeAreaInsets]);

  const handleWebViewError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
    if (!splashHidden.current) {
      splashHidden.current = true;
      SplashScreen.hide();
    }
  }, []);

  const handleRetry = useCallback(() => {
    setHasError(false);
    setIsLoading(true);
    webViewRef.current?.reload();
  }, []);

  const barStyle = statusBarStyle ?? (isDarkMode ? 'light-content' : 'dark-content');
  const topBg = statusBarBg ?? '#FCFCFC';

  return (
    <View style={styles.container}>
      <StatusBar barStyle={barStyle} backgroundColor={statusBarBg ?? 'transparent'} translucent />

      {/* [1] 상단 인셋 스페이서 — 지도 풀블리드(N7) 시 조건부 접기 */}
      {!topCollapsed && <View style={{ height: insets.top, backgroundColor: topBg }} />}

      {/* [2] WebView 영역 */}
      <View style={styles.webviewContainer}>
        {hasError ? (
          <View style={styles.errorContainer}>
            <Text style={styles.errorTitle}>연결에 실패했습니다</Text>
            <Text style={styles.errorMessage}>
              {!isConnected ? '인터넷 연결을 확인해주세요.' : '페이지를 불러올 수 없습니다.'}
            </Text>
            <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
              <Text style={styles.retryButtonText}>다시 시도</Text>
            </TouchableOpacity>
          </View>
        ) : (
          <>
            {isLoading && (
              <View style={styles.loadingContainer}>
                <LottieView
                  source={require('./assets/loading/loading.json')}
                  autoPlay
                  loop
                  style={styles.lottieAnimation}
                />
              </View>
            )}
            <WebView
              ref={webViewRef}
              source={{ uri: WEB_URL }}
              style={styles.webview}
              javaScriptEnabled
              domStorageEnabled
              thirdPartyCookiesEnabled
              sharedCookiesEnabled
              cacheEnabled
              cacheMode="LOAD_DEFAULT"
              startInLoadingState={false}
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              allowsBackForwardNavigationGestures
              userAgent={`${BASE_USER_AGENT} RaisingApp/${APP_VERSION} (${Platform.OS})`}
              injectedJavaScriptBeforeContentLoaded={bootstrapJs}
              onMessage={handleWebViewMessage}
              onLoadEnd={handleWebViewLoadEnd}
              onError={handleWebViewError}
              onHttpError={handleWebViewError}
              onContentProcessDidTerminate={() => webViewRef.current?.reload()}
            />
          </>
        )}
      </View>

      {/* [3] 네이티브 탭바(형제) + [4] 하단 인셋은 탭바가 paddingBottom으로 흡수 */}
      <NativeTabBar
        activeTab={activeTab}
        bottomInset={insets.bottom}
        onTabPress={handleTabPress}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FCFCFC' },
  webviewContainer: { flex: 1 },
  webview: { flex: 1 },
  loadingContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: '#FFF',
    zIndex: 1000,
  },
  lottieAnimation: { width: 100, height: 100 },
  errorContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 20,
    backgroundColor: '#FFF',
  },
  errorTitle: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#333',
    marginBottom: 12,
    textAlign: 'center',
  },
  errorMessage: {
    fontSize: 16,
    color: '#666',
    marginBottom: 24,
    textAlign: 'center',
    lineHeight: 22,
  },
  retryButton: {
    backgroundColor: '#007AFF',
    paddingHorizontal: 24,
    paddingVertical: 12,
    borderRadius: 8,
  },
  retryButtonText: { color: '#FFF', fontSize: 16, fontWeight: '600' },
});

export default App;
