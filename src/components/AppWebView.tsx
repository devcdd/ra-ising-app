/**
 * 한 탭의 WebView + 네이티브 브리지. react-native-bottom-tabs의 각 탭 scene으로 렌더된다.
 * (단일 WebView → 탭별 WebView 모델 전환: D1 폐기. 각 인스턴스가 자기 라우트의 웹을 로드하고 브리지를 독립 소유.)
 */
import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import {
  AppState,
  Keyboard,
  NativeModules,
  Platform,
  StatusBar,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { WebView, type WebViewMessageEvent } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useBottomTabBarHeight } from 'react-native-bottom-tabs';
import Geolocation from '@react-native-community/geolocation';
import NetInfo from '@react-native-community/netinfo';
import LottieView from 'lottie-react-native';

import {
  BRIDGE_PROTOCOL_VERSION,
  BridgeMethods,
  BridgeTopics,
  isEnvelope,
  type ActiveTab,
  type BridgeError,
  type Insets,
  type RaisingAppGlobal,
  type RpcRequestEnvelope,
  type StatusBarStyle,
} from '../bridge/protocol';
import {
  injectRaw,
  postError,
  postEvent,
  postResponse,
} from '../bridge/messaging';
import { buildBootstrapJs } from '../bridge/injectedJs';
import { createRpcHandlers } from '../bridge/rpcHandlers';

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

const WEB_BASE_URL = resolveWebUrl();

if (__DEV__) {
  console.log('[dev] WebView base =', WEB_BASE_URL);
}

const APP_VERSION = '1.1.0';
const TAB_BAR_HEIGHT = 56; // handshake 참조값(네이티브 탭바 실제 높이는 시스템이 관리)

const CAPABILITIES = Object.values(BridgeMethods).filter(
  m =>
    !m.startsWith('push.') &&
    !m.startsWith('imagePicker.') &&
    !m.startsWith('camera.'),
);
const OPEN_URL_SCHEMES = [
  'tel',
  'mailto',
  'nmap',
  'kakaomap',
  'itms-apps',
  'app-settings',
];
// UA는 웹의 플랫폼 폴백 경로다 — __RAISING_APP__ 주입이 늦으면(Android는 onPageStarted에서 evaluateJavascript라
// 페이지 스크립트와 레이스한다) 웹이 UA로 플랫폼을 판별한다. 그래서 UA가 플랫폼과 어긋나면 안 된다.
//  iOS: 아이폰 Safari로 위장한 기존 UA 유지(카카오/서버가 의존할 수 있어 건드리지 않는다).
//  Android: userAgent를 덮어쓰지 않고 applicationNameForUserAgent만 준다 → RNW가 WebSettings.getDefaultUserAgent()
//           뒤에 토큰을 덧붙인다(진짜 Android UA + RaisingApp 토큰). 가짜 UA를 박지 않으니 크롬 버전도 안 늙는다.
const IOS_BASE_USER_AGENT =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1';
const USER_AGENT_PROPS =
  Platform.OS === 'ios'
    ? { userAgent: `${IOS_BASE_USER_AGENT} RaisingApp/${APP_VERSION} (ios)` }
    : { applicationNameForUserAgent: `RaisingApp/${APP_VERSION} (android)` };

interface AppWebViewProps {
  /** 이 탭이 로드할 웹 라우트 (예: '/', '/map'). */
  initialPath: string;
  /** 이 scene의 탭 key (포커스 판별용). */
  tabKey: string;
  /** 웹 ROUTE_CHANGED를 상위로 전달 — 네이티브 탭 선택 동기화(강제 라우팅 반영). */
  onRouteChange?: (tabKey: string, activeTab: string | null) => void;
  /** 웹 SET_TAB_BAR를 상위로 전달 — 풀스크린 커버 시 전역 탭바 숨김(라우트 무관). */
  onImmersiveChange?: (tabKey: string, hidden: boolean) => void;
  /** 웹 SWITCH_TAB을 상위로 전달 — 다른 탭 소유 라우트로 갈 때 탭 전환 + 그 탭 WebView 로드. */
  onSwitchTab?: (tab: string, path: string) => void;
}

/** 상위(App)가 이 탭의 WebView를 명령형으로 조작하기 위한 핸들 — OAuth 딥링크 복귀 / 재탭 / 하드웨어 백 등. */
export interface AppWebViewHandle {
  /** 이 탭 WebView를 주어진 웹 경로로 네비게이트(NAVIGATE 이벤트 → 웹 router.navigate). */
  navigate: (path: string) => void;
  /** 하드웨어 백(Android)을 이 탭의 웹에 위임. 위임했으면 true, 웹이 되돌릴 게 없으면 false(→ 안드로이드 기본 동작). */
  handleBack: () => boolean;
  /** 활성 탭 재탭 — 스택이 쌓여 있으면 탭 루트로 되감고, 이미 루트면 스크롤만 top으로. */
  retap: () => void;
}

const AppWebView = forwardRef<AppWebViewHandle, AppWebViewProps>(
  (
    { initialPath, tabKey, onRouteChange, onImmersiveChange, onSwitchTab },
    ref,
  ) => {
    const insets = useSafeAreaInsets();
    const tabBarHeight = useBottomTabBarHeight(); // 네이티브 탭바가 오버레이하는 하단 높이(safe area 포함)

    const [isLoading, setIsLoading] = useState(true);
    const [hasError, setHasError] = useState(false);
    const [isConnected, setIsConnected] = useState(true);
    const [appState, setAppState] = useState(AppState.currentState);
    const [isTabRoute, setIsTabRoute] = useState(true); // 현재 웹 라우트가 탭에 해당하는지(탭바 표시 여부와 동조)
    const [immersive, setImmersive] = useState(false); // 풀스크린 커버(SET_TAB_BAR) — 탭바를 덮어 숨김
    const [statusBarStyle, setStatusBarStyle] = useState<StatusBarStyle | null>(
      null,
    );
    const [statusBarBg, setStatusBarBg] = useState<string | undefined>(
      undefined,
    );

    const webViewRef = useRef<WebView>(null);
    const geoWatches = useRef<Map<string, number>>(new Map());
    const backCanHandle = useRef(false); // G5: 웹이 push한 "back 처리 가능" 상태 미러
    const isAtTabRootRef = useRef(true); // ROUTE_CHANGED.isRootOfTab 미러 — 재탭 시 되감기/스크롤 판단
    const webReadyRef = useRef(false); // 웹 로드 완료(브리지 수신 가능) 여부 — 명령형 navigate 버퍼링용
    const pendingNavRef = useRef<string | null>(null); // 웹 미준비 시 보류한 navigate 경로(로드 후 flush)

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

    const bootstrapJs = useMemo(() => {
      const appGlobal: RaisingAppGlobal = {
        platform: Platform.OS === 'ios' ? 'ios' : 'android',
        appVersion: APP_VERSION,
        bridgeProtocol: BRIDGE_PROTOCOL_VERSION,
        insets: rawInsets,
        tabBar: { native: true, height: TAB_BAR_HEIGHT },
        capabilities: CAPABILITIES,
        openURLSchemes: OPEN_URL_SCHEMES,
        tab: tabKey as ActiveTab, // 이 WebView의 소유 탭 — 웹이 크로스탭 네비를 판별하는 데 사용.
      };
      return buildBootstrapJs(appGlobal);
    }, [rawInsets, tabKey]);

    const emit = useCallback(
      (topic: string, payload?: unknown) =>
        postEvent(webViewRef.current, topic, payload),
      [],
    );

    // 상위(App)가 이 탭 WebView를 명령형으로 조작한다 — OAuth 복귀 / 크로스탭 전환 / 재탭 / 하드웨어 백.
    useImperativeHandle(
      ref,
      () => ({
        // 웹이 아직 로드 전이면(콜드 마운트) 경로를 보류했다가 onLoadEnd에서 flush한다.
        navigate: (path: string) => {
          if (webReadyRef.current) {
            emit(BridgeTopics.navigate, { path });
          } else {
            pendingNavRef.current = path;
          }
        },
        // webView.canGoBack이 아니라 back.state.canHandle을 쓴다: 웹 히스토리 항목이 화면과 1:1이 아니고
        // (지도 상세 시트 같은 step도 히스토리를 쓴다), pop은 웹이 주도한다.
        handleBack: () => {
          if (!backCanHandle.current) {
            return false; // 웹이 되돌릴 게 없다(탭 루트) → 안드로이드 기본 동작(종료/백그라운드)에 맡긴다.
          }
          emit(BridgeTopics.androidBackPress);
          return true;
        },
        // 탭 루트로 NAVIGATE하면 웹은 새 화면을 쌓지 않고 살아있는 루트 화면으로 되감는다(pop-to).
        retap: () => {
          if (!webReadyRef.current) {
            return; // 콜드 탭 — 어차피 루트를 로드 중이라 되감을 것도 스크롤할 것도 없다.
          }
          if (isAtTabRootRef.current) {
            emit(BridgeTopics.scrollTop);
          } else {
            emit(BridgeTopics.navigate, { path: initialPath });
          }
        },
      }),
      [emit, initialPath],
    );

    // 잔여 인셋(§2.7.1): top은 풀블리드일 때만 실값. bottom은 탭 라우트(탭바 표시)면 탭바 높이,
    // 비-탭 라우트(탭바 숨김)면 홈인디케이터만 — 빈 갭 방지. 적용은 웹이 레이아웃별로 결정(지도는 풀블리드).
    const emitSafeAreaInsets = useCallback(() => {
      // 커버(immersive) 중엔 탭바가 사라져 WebView가 그 자리를 차지 → 하단 예약은 홈인디케이터만.
      const tabBarShown = isTabRoute && !immersive;
      emit(BridgeTopics.safeAreaInsets, {
        insets: {
          // 상단은 항상 실 인셋을 전달 — WebView를 edge-to-edge로 두고 웹이 --safe-top 패딩으로 처리(네이티브 흰 띠 제거).
          top: insets.top,
          bottom: tabBarShown ? tabBarHeight : insets.bottom,
          left: 0,
          right: 0,
        },
      });
    }, [emit, insets.top, insets.bottom, isTabRoute, immersive, tabBarHeight]);

    // ---- geolocation (N5): navigator.geolocation 셰임(GEO_*) + 형식 RPC ----
    const geoCall = useCallback(
      (fn: 'resolve' | 'reject' | 'update' | 'fail', id: string, arg: object) =>
        injectRaw(
          webViewRef.current,
          `window.__RAISING_GEO__&&window.__RAISING_GEO__.${fn}(${JSON.stringify(
            id,
          )},${JSON.stringify(arg)})`,
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
            pos =>
              geoCall('resolve', id, {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
              }),
            err =>
              geoCall('reject', id, { code: err.code, message: err.message }),
            {
              enableHighAccuracy: options?.enableHighAccuracy ?? true,
              timeout: options?.timeout ?? 15000,
              maximumAge: options?.maximumAge ?? 10000,
            },
          );
        } else if (type === 'GEO_WATCH') {
          const nativeId = Geolocation.watchPosition(
            pos =>
              geoCall('update', id, {
                latitude: pos.coords.latitude,
                longitude: pos.coords.longitude,
                accuracy: pos.coords.accuracy,
              }),
            err =>
              geoCall('fail', id, { code: err.code, message: err.message }),
            {
              enableHighAccuracy: options?.enableHighAccuracy ?? true,
              distanceFilter: 0,
            },
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
              pos =>
                postResponse(wv, req.id, {
                  latitude: pos.coords.latitude,
                  longitude: pos.coords.longitude,
                  accuracy: pos.coords.accuracy,
                }),
              err =>
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
              pos =>
                emit(BridgeTopics.geoWatchUpdate, {
                  watchId: req.id,
                  latitude: pos.coords.latitude,
                  longitude: pos.coords.longitude,
                }),
              () => {},
              {
                enableHighAccuracy: params?.enableHighAccuracy ?? true,
                distanceFilter: 0,
              },
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
              : {
                  code: 'E_NATIVE',
                  message: String((e as Error)?.message ?? e),
                };
          postError(wv, req.id, err);
        }
      },
      [emit, rpcHandlers, stopWatch],
    );

    // ---- 웹→네이티브 이벤트 ----
    const handleWebEvent = useCallback(
      (topic: string, payload: any) => {
        switch (topic) {
          case BridgeTopics.routeChanged: {
            const at = (payload?.activeTab as string) ?? null;
            onRouteChange?.(tabKey, at); // 네이티브 탭 선택 동기화 + 비-탭이면 탭바 숨김(상위)
            setIsTabRoute(at != null); // 이 WebView 하단 예약 조정(탭바 높이 vs 홈인디케이터)
            isAtTabRootRef.current = Boolean(payload?.isRootOfTab); // 재탭 시 되감기(false) vs 스크롤 top(true)
            break;
          }
          case BridgeTopics.setTabBar: {
            // 풀스크린 커버 — 탭바 숨김/복원(멱등)
            const hidden = Boolean(payload?.hidden);
            setImmersive(hidden); // 이 WebView 하단 인셋(탭바 자리 회수) 조정
            onImmersiveChange?.(tabKey, hidden); // 전역 탭바 숨김(상위)
            break;
          }
          case BridgeTopics.switchTab: {
            // 다른 탭 소유 라우트로 이동 — 탭 전환 + 그 탭 WebView 로드(상위 처리)
            const tab = payload?.tab as string | undefined;
            const path = payload?.path as string | undefined;
            if (tab && path) {
              onSwitchTab?.(tab, path);
            }
            break;
          }
          case BridgeTopics.setSafeAreaMode:
            // 더 이상 사용 안 함 — 상단 인셋은 항상 웹이 --safe-top 패딩으로 처리(네이티브 상단 띠 제거). 멱등 no-op.
            break;
          case BridgeTopics.setStatusBar:
            setStatusBarStyle((payload?.style as StatusBarStyle) ?? null);
            setStatusBarBg(payload?.backgroundColor);
            break;
          case BridgeTopics.backState: // G5
            backCanHandle.current = Boolean(payload?.canHandle);
            break;
          default:
            break;
        }
      },
      [onRouteChange, onImmersiveChange, onSwitchTab, tabKey],
    );

    const handleWebViewMessage = useCallback(
      (event: WebViewMessageEvent) => {
        let data: any;
        try {
          data = JSON.parse(event.nativeEvent.data);
        } catch {
          return;
        }
        if (
          data?.type === 'GEO_GET_CURRENT' ||
          data?.type === 'GEO_WATCH' ||
          data?.type === 'GEO_CLEAR_WATCH'
        ) {
          handleGeoShim(data.type, String(data.id), data.options);
          return;
        }
        if (isEnvelope(data)) {
          if (data.kind === 'rpc.request') {
            handleRpcRequest(data);
          } else if (data.kind === 'event') {
            handleWebEvent(data.topic, data.payload);
          }
        }
      },
      [handleGeoShim, handleRpcRequest, handleWebEvent],
    );

    // ---- 네트워크(N16) ----
    useEffect(() => {
      const unsubscribe = NetInfo.addEventListener(state => {
        const connected = state.isConnected ?? false;
        setIsConnected(connected);
        if (connected && hasError) {
          setHasError(false);
        }
        emit(BridgeTopics.netStatus, {
          isConnected: connected,
          type: state.type,
        });
      });
      return () => unsubscribe();
    }, [emit, hasError]);

    // ---- 앱 라이프사이클(N15) ----
    useEffect(() => {
      const sub = AppState.addEventListener('change', next => {
        if (appState.match(/inactive|background/) && next === 'active') {
          setHasError(false);
        }
        setAppState(next);
        emit(BridgeTopics.appLifecycle, { state: next });
      });
      return () => sub.remove();
    }, [appState, emit]);

    // ---- 키보드(N9, G3 잠정) ----
    useEffect(() => {
      const showEvt =
        Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
      const hideEvt =
        Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
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

    // 백버튼 위임(N11, Android, G5)은 App이 단독 구독한다 — 여기서 탭마다 구독하면 방문한 탭 수만큼
    // 핸들러가 살아남고, RN BackHandler는 마지막 등록분부터 호출하므로 포커스와 무관한 탭이 백을 가로챈다.
    // App이 포커스된 탭의 handleBack()만 호출한다.

    // ---- 인셋/모드 변화 시 잔여 인셋 송신(N6/N7) ----
    useEffect(() => {
      emitSafeAreaInsets();
    }, [emitSafeAreaInsets]);

    const handleWebViewLoadEnd = useCallback(() => {
      setIsLoading(false);
      setHasError(false);
      webReadyRef.current = true;
      emitSafeAreaInsets();
      // 콜드 마운트 중 보류된 navigate flush. 웹 리스너 등록 타이밍 갭 대비 1회 재발신(동일 경로라 무해).
      const pending = pendingNavRef.current;
      if (pending) {
        pendingNavRef.current = null;
        emit(BridgeTopics.navigate, { path: pending });
        setTimeout(() => emit(BridgeTopics.navigate, { path: pending }), 250);
      }
    }, [emit, emitSafeAreaInsets]);

    const handleWebViewError = useCallback(() => {
      setIsLoading(false);
      setHasError(true);
      webReadyRef.current = false;
    }, []);

    const handleRetry = useCallback(() => {
      setHasError(false);
      setIsLoading(true);
      webViewRef.current?.reload();
    }, []);

    const barStyle = statusBarStyle ?? 'dark-content';

    return (
      <View style={styles.container}>
        <StatusBar
          barStyle={barStyle}
          backgroundColor={statusBarBg ?? 'transparent'}
          translucent
        />

        {/* 상단 흰 띠 제거 — WebView가 상태바 아래까지 채우고(edge-to-edge), 상단 인셋은 웹이 --safe-top 패딩으로 처리. */}
        <View style={styles.webviewContainer}>
          {hasError ? (
            <View style={styles.errorContainer}>
              <Text style={styles.errorTitle}>연결에 실패했습니다</Text>
              <Text style={styles.errorMessage}>
                {!isConnected
                  ? '인터넷 연결을 확인해주세요.'
                  : '페이지를 불러올 수 없습니다.'}
              </Text>
              <TouchableOpacity
                style={styles.retryButton}
                onPress={handleRetry}
              >
                <Text style={styles.retryButtonText}>다시 시도</Text>
              </TouchableOpacity>
            </View>
          ) : (
            <>
              {isLoading && (
                <View style={styles.loadingContainer}>
                  <LottieView
                    source={require('../../assets/loading/loading.json')}
                    autoPlay
                    loop
                    style={styles.lottieAnimation}
                  />
                </View>
              )}
              <WebView
                ref={webViewRef}
                source={{ uri: `${WEB_BASE_URL}${initialPath}` }}
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
                // 웹(Stackflow)이 뒤로가기를 온전히 소유한다 — 절대 켜지 말 것.
                // 화면 push마다 history.pushState가 쌓이므로 켜면 ① WKWebView 스냅샷 흰 화면이 재발하고
                // ② 좌측 엣지 스와이프에 네이티브 백과 웹 cupertino 전환이 동시에 반응한다.
                allowsBackForwardNavigationGestures={false}
                {...USER_AGENT_PROPS}
                injectedJavaScriptBeforeContentLoaded={bootstrapJs}
                onMessage={handleWebViewMessage}
                onLoadEnd={handleWebViewLoadEnd}
                onError={handleWebViewError}
                onHttpError={handleWebViewError}
                onContentProcessDidTerminate={() =>
                  webViewRef.current?.reload()
                }
              />
            </>
          )}
        </View>
      </View>
    );
  },
);

AppWebView.displayName = 'AppWebView';

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

export default AppWebView;
