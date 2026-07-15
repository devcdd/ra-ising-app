/**
 * 루트 — react-native-bottom-tabs 네이티브 탭바(iOS 26 Liquid Glass 자동) + 탭별 WebView.
 * 탭 전환/하이라이트는 네이티브 UITabBar가 소유. 각 탭은 자기 라우트의 웹(AppWebView)을 로드한다.
 * (단일 WebView 모델 D1 폐기 — 탭별 WebView. 인증은 쿠키 공유로 유지.)
 *
 * @format
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, BackHandler, Linking, Platform } from 'react-native';
import TabView from 'react-native-bottom-tabs';
import Geolocation from '@react-native-community/geolocation';
import SplashScreen from 'react-native-splash-screen';
import { initializeKakaoSDK } from '@react-native-kakao/core';
import ReactNativeHapticFeedback from 'react-native-haptic-feedback';

import AppWebView, { type AppWebViewHandle } from './src/components/AppWebView';

type TabKey = 'home' | 'map' | 'community' | 'my';

// OAuth 커스텀 스킴 딥링크(raisingapp://oauth/<provider>?code=...) → 웹 콜백 경로로 변환.
const OAUTH_DEEP_LINK = /^raisingapp:\/\/oauth\/([^/?]+)(\?[^#]*)?/i;

// 카카오 네이티브 앱키(JavaScript 키와 다름) — Kakao Developers > 내 앱 > 앱 키 > 네이티브 앱 키.
// iOS 번들(ramenroad.ra-ising-app)이 등록된 앱의 네이티브 키. 콘솔 네이티브 앱 스킴 kakao{이 값}과 일치해야 한다.
// 네이티브 키는 클라이언트에 임베드되는 값이라 비밀이 아니다(WEB_BASE_URL처럼 상수로 둔다).
const KAKAO_NATIVE_APP_KEY = '5504598a813e17026c2e56b6feee8214';

// 탭 → 웹 라우트. 'my'의 로그인 분기는 웹이 처리(비로그인 시 /login 리다이렉트).
const PATH_BY_KEY: Record<TabKey, string> = {
  home: '/',
  map: '/map',
  community: '/community',
  my: '/mypage',
};

const HAPTIC_OPTS = {
  enableVibrateFallback: true,
  ignoreAndroidSystemSettings: false,
};

// 아이콘은 웹 SVG를 PNG로 래스터화한 것(scripts/gen-tab-icons.mjs). focused=#292929 / unfocused=#CFCFCF.
const ROUTES = [
  {
    key: 'home',
    title: '홈',
    focusedIcon: require('./assets/tabs/home_active.png'),
    unfocusedIcon: require('./assets/tabs/home_inactive.png'),
  },
  {
    key: 'map',
    title: '지도',
    focusedIcon: require('./assets/tabs/map_active.png'),
    unfocusedIcon: require('./assets/tabs/map_inactive.png'),
  },
  {
    key: 'community',
    title: '커뮤니티',
    focusedIcon: require('./assets/tabs/community_active.png'),
    unfocusedIcon: require('./assets/tabs/community_inactive.png'),
  },
  {
    key: 'my',
    title: '마이',
    focusedIcon: require('./assets/tabs/user_active.png'),
    unfocusedIcon: require('./assets/tabs/user_inactive.png'),
  },
];

function App() {
  const [index, setIndex] = useState(0);
  const [routes] = useState(ROUTES);
  // 탭바 숨김은 두 입력의 OR: ① 비-탭 라우트(상세/로그인 등) ② 풀스크린 커버(SET_TAB_BAR, 인페이지 모달 포함).
  const [routeHidden, setRouteHidden] = useState(false);
  const [coverHidden, setCoverHidden] = useState(false);
  const tabBarHidden = routeHidden || coverHidden;
  const indexRef = useRef(index);
  indexRef.current = index;

  // 각 탭 WebView 핸들 — OAuth 딥링크 복귀 시 해당 탭 WebView를 콜백 경로로 보내기 위함.
  const webViewRefs = useRef<Partial<Record<TabKey, AppWebViewHandle | null>>>(
    {},
  );

  // 웹 라우트(ROUTE_CHANGED) → 네이티브 탭 동기화. 포커스된 탭의 보고만 반영(백그라운드가 가로채지 않게).
  //  - 탭 라우트면: 탭바 표시 + 해당 탭 선택(강제 라우팅 마이→홈에도 따라옴)
  //  - 비-탭 라우트(상세/로그인 등)면: 탭바를 잠시 숨김
  const handleRouteChange = useCallback(
    (sourceKey: string, activeTab: string | null) => {
      if (sourceKey !== ROUTES[indexRef.current].key) {
        return;
      }
      if (!activeTab) {
        setRouteHidden(true);
        return;
      }
      setRouteHidden(false);
      const target = ROUTES.findIndex(r => r.key === activeTab);
      if (target >= 0 && target !== indexRef.current) {
        setIndex(target);
      }
    },
    [],
  );

  // 풀스크린 커버(SET_TAB_BAR) → 전역 탭바 숨김. 포커스된 탭의 보고만 반영.
  const handleImmersiveChange = useCallback(
    (sourceKey: string, hidden: boolean) => {
      if (sourceKey !== ROUTES[indexRef.current].key) {
        return;
      }
      setCoverHidden(hidden);
    },
    [],
  );

  // 특정 탭으로 전환하고 그 탭 WebView를 주어진 경로로 네비게이트. 콜드 마운트면 마운트까지 잠깐 재시도.
  const navigateTab = useCallback((tabKey: TabKey, path: string) => {
    const target = ROUTES.findIndex(r => r.key === tabKey);
    if (target >= 0) {
      setIndex(target);
    }
    let tries = 0;
    const send = () => {
      const handle = webViewRefs.current[tabKey];
      if (handle) {
        handle.navigate(path);
        return;
      }
      if (tries++ < 20) {
        setTimeout(send, 150);
      }
    };
    send();
  }, []);

  // 탭바 터치. 네이티브는 활성 탭을 다시 눌러도 같은 index로 이 콜백을 올려준다
  // (iOS UITabBarController 재선택 / Android 아이템뷰 클릭) → 재탭으로 판정해 웹에 위임한다.
  // 다른 탭으로의 전환은 WebView를 리로드하지 않는다 — 탭별 WebView가 상주하므로 스택·스크롤이 그대로 살아있다.
  const handleIndexChange = useCallback((nextIndex: number) => {
    if (nextIndex === indexRef.current) {
      webViewRefs.current[ROUTES[nextIndex].key as TabKey]?.retap();
      return;
    }
    ReactNativeHapticFeedback.trigger('impactMedium', HAPTIC_OPTS);
    setIndex(nextIndex);
  }, []);

  // OAuth 딥링크 복귀: 마이 탭으로 전환 + 그 WebView를 콜백 경로(/oauth/<provider>?code=)로 보낸다.
  // (로그인은 마이 탭에서 시작 → 카톡 인앱 브라우저가 raisingapp:// 스킴으로 앱을 깨움 → 웹이 isApp 컨텍스트에서 토큰 교환.)
  const forwardOAuthDeepLink = useCallback(
    (url: string) => {
      const m = OAUTH_DEEP_LINK.exec(url);
      if (!m) {
        return;
      }
      navigateTab('my', `/oauth/${m[1]}${m[2] ?? ''}`);
    },
    [navigateTab],
  );

  // 크로스탭 네비(SWITCH_TAB): 홈에서 검색 → 지도처럼 다른 탭 소유 라우트로 갈 때.
  // 원본 탭 WebView는 그대로 두고(오염 방지), 대상 탭으로 전환 + 그 탭 WebView만 경로 로드.
  const handleSwitchTab = useCallback(
    (tab: string, path: string) => {
      navigateTab(tab as TabKey, path);
    },
    [navigateTab],
  );

  // 하드웨어 백(Android) — 앱이 단독 구독하고 포커스된 탭에만 위임한다.
  // 탭별 WebView가 각자 구독하면 방문한 탭 수만큼 핸들러가 살아남는데, RN BackHandler는 마지막 등록분부터
  // 호출하고 첫 true에서 멈추므로 포커스와 무관한 탭이 백을 영구히 가로챈다.
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return;
    }
    const onBack = () => {
      const key = ROUTES[indexRef.current].key as TabKey;
      // 웹이 되돌릴 게 있으면(back.state.canHandle) pop을 위임하고 소비한다.
      // 없으면(탭 루트) false → 안드로이드 기본 동작(앱 종료/백그라운드).
      return webViewRefs.current[key]?.handleBack() ?? false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, []);

  useEffect(() => {
    const sub = Linking.addEventListener('url', ({ url }) =>
      forwardOAuthDeepLink(url),
    );
    Linking.getInitialURL().then(url => {
      if (url) {
        forwardOAuthDeepLink(url);
      }
    });
    return () => sub.remove();
  }, [forwardOAuthDeepLink]);

  // 스플래시 1회 해제.
  useEffect(() => {
    SplashScreen.hide();
  }, []);

  // 카카오 SDK 1회 초기화(공유에 사용). 키 미설정 시 init은 무해하나, kakao.share 호출은 네이티브에서 실패한다.
  useEffect(() => {
    initializeKakaoSDK(KAKAO_NATIVE_APP_KEY).catch(() => {
      // 초기화 실패는 공유 시 개별적으로 처리 — 앱 부팅을 막지 않는다.
    });
  }, []);

  // 위치 권한 1회 요청(앱 전역).
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

  return (
    <TabView
      navigationState={{ index, routes }}
      onIndexChange={handleIndexChange}
      tabBarHidden={tabBarHidden}
      renderScene={({ route }) => (
        <AppWebView
          ref={handle => {
            webViewRefs.current[route.key as TabKey] = handle;
          }}
          initialPath={PATH_BY_KEY[route.key as TabKey] ?? '/'}
          tabKey={route.key}
          onRouteChange={handleRouteChange}
          onImmersiveChange={handleImmersiveChange}
          onSwitchTab={handleSwitchTab}
        />
      )}
    />
  );
}

export default App;
