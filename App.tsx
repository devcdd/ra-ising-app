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
  SafeAreaView,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import Geolocation from '@react-native-community/geolocation';

function App() {
  const isDarkMode = useColorScheme() === 'dark';
  const [locationPermission, setLocationPermission] = useState(false);

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

  return (
    <View style={styles.container}>
      <StatusBar
        barStyle={isDarkMode ? 'light-content' : 'dark-content'}
        backgroundColor="transparent"
        translucent={true}
      />
      {/* <SafeAreaView style={styles.topSafeArea} /> */}
      <View style={styles.webviewContainer}>
        <WebView
          ref={webViewRef}
          source={{ uri: 'https://ra-ising.com' }}
          style={styles.webview}
          javaScriptEnabled={true}
          domStorageEnabled={true}
          startInLoadingState={true}
          scalesPageToFit={true}
          allowsInlineMediaPlayback={true}
          mediaPlaybackRequiresUserAction={false}
          allowsBackForwardNavigationGestures={true}
          userAgent="Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1"
          onMessage={handleWebViewMessage}
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
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#FFF',
  },
  topSafeArea: {
    backgroundColor: '#FFF',
  },
  webviewContainer: {
    flex: 1,
  },
  webview: {
    flex: 1,
  },
});

export default App;
