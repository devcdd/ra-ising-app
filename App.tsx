/**
 * WebView App for ramenroad.com
 * https://github.com/facebook/react-native
 *
 * @format
 */

import React, { useEffect, useState, useCallback } from 'react';
import {
  View,
  StatusBar,
  StyleSheet,
  useColorScheme,
  Alert,
  Text,
  TouchableOpacity,
  AppState,
  NativeModules,
  SafeAreaView,
} from 'react-native';
import { WebView } from 'react-native-webview';
import Geolocation from '@react-native-community/geolocation';
import SplashScreen from 'react-native-splash-screen';
import NetInfo from '@react-native-community/netinfo';
import LottieView from 'lottie-react-native';

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

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [locationPermission, setLocationPermission] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [hasError, setHasError] = useState(false);
  const [isConnected, setIsConnected] = useState(true);
  const [appState, setAppState] = useState(AppState.currentState);

  const requestLocationPermission = useCallback(async () => {
    try {
      // 위치 권한 요청 (실제 위치 요청을 통해 권한 확인)
      const granted = await requestLocationPermissionWithGeolocation();
      setLocationPermission(Boolean(granted));

      if (!granted) {
        Alert.alert(
          '위치 권한 필요',
          '이 앱은 위치 기반 서비스를 제공하기 위해 위치 정보가 필요합니다. 설정에서 위치 권한을 허용해주세요.',
          [{ text: '확인' }],
        );
      }
    } catch (error) {
      console.log('위치 권한 요청 실패:', error);
      setLocationPermission(false);
    }
  }, []);

  // 앱 시작 시 위치 권한 요청
  useEffect(() => {
    requestLocationPermission();
  }, [requestLocationPermission]);

  // 스플래시 스크린 즉시 숨기기
  useEffect(() => {
    SplashScreen.hide();
  }, []);

  // 네트워크 연결 상태 모니터링
  useEffect(() => {
    const unsubscribe = NetInfo.addEventListener(state => {
      setIsConnected(state.isConnected ?? false);
      if (state.isConnected && hasError) {
        // 네트워크가 복구되면 에러 상태만 해제
        // WebView는 새로고침하지 않아서 로컬스토리지 유지
        setHasError(false);
      }
    });

    return () => unsubscribe();
  }, [hasError]);

  // 앱 상태 변화 감지
  useEffect(() => {
    const handleAppStateChange = (nextAppState: any) => {
      if (appState.match(/inactive|background/) && nextAppState === 'active') {
        // 앱이 백그라운드에서 포그라운드로 돌아올 때 에러 상태만 초기화
        // WebView는 새로고침하지 않아서 로컬스토리지 유지
        setHasError(false);
      }
      setAppState(nextAppState);
    };

    const subscription = AppState.addEventListener(
      'change',
      handleAppStateChange,
    );
    return () => subscription?.remove();
  }, [appState]);

  const requestLocationPermissionWithGeolocation = async () => {
    return new Promise(resolve => {
      Geolocation.getCurrentPosition(
        () => {
          console.log('위치 권한 허용됨');
          resolve(true);
        },
        error => {
          console.log('위치 권한 거부됨:', error);
          resolve(false);
        },
        {
          enableHighAccuracy: true,
          timeout: 10000,
          maximumAge: 300000, // 5분 캐시
        },
      );
    });
  };

  // 웹뷰에서 geolocation 요청을 처리하는 함수
  const handleGeolocationRequest = (latitude: number, longitude: number) => {
    const geolocationCode = `
      window.navigator.geolocation.getCurrentPosition = function(success, error, options) {
        if (success) {
          success({
            coords: {
              latitude: ${latitude},
              longitude: ${longitude},
              accuracy: 10,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null
            },
            timestamp: Date.now()
          });
        }
      };
      
      // 기존에 대기 중인 geolocation 요청들 실행
      if (window.pendingGeolocationRequests) {
        window.pendingGeolocationRequests.forEach(request => {
          request.success({
            coords: {
              latitude: ${latitude},
              longitude: ${longitude},
              accuracy: 10,
              altitude: null,
              altitudeAccuracy: null,
              heading: null,
              speed: null
            },
            timestamp: Date.now()
          });
        });
        window.pendingGeolocationRequests = [];
      }
    `;
    return geolocationCode;
  };

  // 현재 위치 가져오기
  const getCurrentLocation = (): Promise<{
    latitude: number;
    longitude: number;
  }> => {
    return new Promise((resolve, reject) => {
      Geolocation.getCurrentPosition(
        position => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
          });
        },
        error => {
          reject(error);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
      );
    });
  };

  // 웹뷰 메시지 처리
  const handleWebViewMessage = async (event: any) => {
    try {
      const data = JSON.parse(event.nativeEvent.data);

      if (data.type === 'REQUEST_LOCATION') {
        if (!locationPermission) {
          console.log('위치 권한이 없어서 위치 정보를 제공할 수 없습니다.');
          return;
        }

        try {
          const location = await getCurrentLocation();
          const geolocationCode = handleGeolocationRequest(
            location.latitude,
            location.longitude,
          );

          // 웹뷰에 위치 정보 주입
          webViewRef.current?.injectJavaScript(geolocationCode);
        } catch (error) {
          console.log('위치 정보 가져오기 실패:', error);
          // 에러 발생 시 웹뷰에 에러 전달
          const errorCode = `
            if (window.pendingGeolocationRequests) {
              window.pendingGeolocationRequests.forEach(request => {
                if (request.error) {
                  request.error({
                    code: 1,
                    message: '위치 정보를 가져올 수 없습니다.'
                  });
                }
              });
              window.pendingGeolocationRequests = [];
            }
          `;
          webViewRef.current?.injectJavaScript(errorCode);
        }
      }
    } catch (error) {
      console.log('웹뷰 메시지 처리 실패:', error);
    }
  };

  const webViewRef = React.useRef<WebView>(null);

  // WebView 로딩 완료 핸들러
  const handleWebViewLoadEnd = () => {
    setIsLoading(false);
    setHasError(false);
  };

  // WebView 에러 핸들러
  const handleWebViewError = () => {
    setIsLoading(false);
    setHasError(true);
  };

  // 재시도 함수
  const handleRetry = () => {
    setHasError(false);
    setIsLoading(true);
    // WebView를 완전히 새로고침하지 않고 현재 페이지만 새로고침
    webViewRef.current?.reload();
  };

  // 로딩 화면
  const renderLoadingScreen = () => (
    <View style={styles.loadingContainer}>
      <LottieView
        source={require('./assets/loading/loading.json')}
        autoPlay
        loop
        style={styles.lottieAnimation}
      />
    </View>
  );

  // 에러 화면
  const renderErrorScreen = () => (
    <View style={styles.errorContainer}>
      <Text style={styles.errorTitle}>연결에 실패했습니다</Text>
      <Text style={styles.errorMessage}>
        {!isConnected
          ? '인터넷 연결을 확인해주세요.'
          : '페이지를 불러올 수 없습니다.'}
      </Text>
      <TouchableOpacity style={styles.retryButton} onPress={handleRetry}>
        <Text style={styles.retryButtonText}>다시 시도</Text>
      </TouchableOpacity>
    </View>
  );

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle={isDarkMode ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
        translucent={true}
      />
      <SafeAreaView style={styles.topSafeArea} />
      <View style={styles.webviewContainer}>
        {hasError ? (
          renderErrorScreen()
        ) : (
          <>
            {isLoading && renderLoadingScreen()}
            <WebView
              ref={webViewRef}
              source={{ uri: WEB_URL }}
              style={styles.webview}
              javaScriptEnabled={true}
              domStorageEnabled={true}
              thirdPartyCookiesEnabled={true}
              sharedCookiesEnabled={true}
              cacheEnabled={true}
              cacheMode="LOAD_DEFAULT"
              startInLoadingState={false}
              scalesPageToFit={true}
              allowsInlineMediaPlayback={true}
              mediaPlaybackRequiresUserAction={false}
              allowsBackForwardNavigationGestures={true}
              userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
              onMessage={handleWebViewMessage}
              onLoadEnd={handleWebViewLoadEnd}
              onError={handleWebViewError}
              onHttpError={handleWebViewError}
              onContentProcessDidTerminate={() => {
                // 웹뷰 프로세스가 종료되면 자동으로 재로딩
                webViewRef.current?.reload();
              }}
              injectedJavaScript={`
                // 웹뷰에서 geolocation 요청을 앱으로 전달하는 코드
                (function() {
                  const originalGetCurrentPosition = navigator.geolocation.getCurrentPosition;
                  const originalWatchPosition = navigator.geolocation.watchPosition;
                  
                  navigator.geolocation.getCurrentPosition = function(success, error, options) {
                    // 앱에 위치 요청 메시지 전송
                    window.ReactNativeWebView.postMessage(JSON.stringify({
                      type: 'REQUEST_LOCATION'
                    }));
                    
                    // 기존 요청을 저장해두고 나중에 실행
                    if (!window.pendingGeolocationRequests) {
                      window.pendingGeolocationRequests = [];
                    }
                    window.pendingGeolocationRequests.push({ success, error, options });
                  };
                  
                  navigator.geolocation.watchPosition = function(success, error, options) {
                    // watchPosition도 동일하게 처리
                    window.ReactNativeWebView.postMessage(JSON.stringify({
                      type: 'REQUEST_LOCATION'
                    }));
                    
                    if (!window.pendingGeolocationRequests) {
                      window.pendingGeolocationRequests = [];
                    }
                    window.pendingGeolocationRequests.push({ success, error, options });
                    
                    // watchPosition의 경우 interval ID 반환
                    return setInterval(() => {
                      window.ReactNativeWebView.postMessage(JSON.stringify({
                        type: 'REQUEST_LOCATION'
                      }));
                    }, 1000);
                  };
                })();
              `}
            />
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FCFCFC',
  },
  topSafeArea: {
    backgroundColor: '#FCFCFC',
  },
  webviewContainer: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
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
  loadingText: {
    marginTop: 16,
    fontSize: 16,
    color: '#666',
  },
  lottieAnimation: {
    width: 100,
    height: 100,
  },
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
  retryButtonText: {
    color: '#FFF',
    fontSize: 16,
    fontWeight: '600',
  },
});

export default App;
