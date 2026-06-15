/**
 * injectedJavaScriptBeforeContentLoaded 부트스트랩 (N2 + N5).
 *
 * 1) window.__RAISING_APP__ 핸드셰이크 객체 주입 (첫 페인트 전, 멱등).
 * 2) navigator.geolocation 셰임 — 표준 API를 네이티브로 위임. **1초 폴링 제거**.
 *    페이지 코드가 직접 호출하는 표준 API라, 웹 bridge 런타임 유무와 무관하게 자립 동작해야 한다
 *    (구/신 웹 공통). 네이티브는 GEO_* 메시지를 받아 __RAISING_GEO__.resolve/update로 회신.
 */
import type { RaisingAppGlobal } from './protocol';

export const buildBootstrapJs = (app: RaisingAppGlobal): string => `
(function(){
  try { window.__RAISING_APP__ = ${JSON.stringify(app)}; } catch (e) {}
  if (window.__RAISING_GEO_PATCHED__) { return; }
  window.__RAISING_GEO_PATCHED__ = true;
  var seq = 0;
  var oneShot = {};
  var watches = {};
  function post(msg){
    if (window.ReactNativeWebView) {
      window.ReactNativeWebView.postMessage(JSON.stringify(msg));
    }
  }
  function toPosition(c){
    return { coords: {
      latitude: c.latitude,
      longitude: c.longitude,
      accuracy: (c.accuracy != null ? c.accuracy : 10),
      altitude: null, altitudeAccuracy: null, heading: null, speed: null
    }, timestamp: Date.now() };
  }
  function toError(e){
    e = e || {};
    return { code: (e.code || 2), message: (e.message || '위치 정보를 가져올 수 없습니다.'),
      PERMISSION_DENIED: 1, POSITION_UNAVAILABLE: 2, TIMEOUT: 3 };
  }
  window.__RAISING_GEO__ = {
    resolve: function(id, c){ var cb = oneShot[id]; delete oneShot[id]; if (cb && cb.success) { cb.success(toPosition(c)); } },
    reject: function(id, e){ var cb = oneShot[id]; delete oneShot[id]; if (cb && cb.error) { cb.error(toError(e)); } },
    update: function(id, c){ var cb = watches[id]; if (cb && cb.success) { cb.success(toPosition(c)); } },
    fail: function(id, e){ var cb = watches[id]; if (cb && cb.error) { cb.error(toError(e)); } }
  };
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition = function(success, error, options){
      var id = 'g' + (++seq);
      oneShot[id] = { success: success, error: error };
      post({ type: 'GEO_GET_CURRENT', id: id, options: options || {} });
    };
    navigator.geolocation.watchPosition = function(success, error, options){
      var id = 'w' + (++seq);
      watches[id] = { success: success, error: error };
      post({ type: 'GEO_WATCH', id: id, options: options || {} });
      return id;
    };
    navigator.geolocation.clearWatch = function(id){
      delete watches[id];
      post({ type: 'GEO_CLEAR_WATCH', id: id });
    };
  }
})();
true;
`;
