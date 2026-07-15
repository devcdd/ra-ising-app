import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    return true
  }

  // iOS 26 SDK부터 UIScene 생명주기가 강제된다. 실제 window/RN 부팅은 SceneDelegate에서 수행.
  func application(
    _ application: UIApplication,
    configurationForConnecting connectingSceneSession: UISceneSession,
    options: UIScene.ConnectionOptions
  ) -> UISceneConfiguration {
    let configuration = UISceneConfiguration(
      name: "Default Configuration",
      sessionRole: connectingSceneSession.role
    )
    configuration.delegateClass = SceneDelegate.self
    return configuration
  }
}

class SceneDelegate: UIResponder, UIWindowSceneDelegate {
  var window: UIWindow?
  var splashView: UIView?

  func scene(
    _ scene: UIScene,
    willConnectTo session: UISceneSession,
    options connectionOptions: UIScene.ConnectionOptions
  ) {
    guard let windowScene = scene as? UIWindowScene,
          let appDelegate = UIApplication.shared.delegate as? AppDelegate,
          let factory = appDelegate.reactNativeFactory else { return }

    let window = UIWindow(windowScene: windowScene)
    self.window = window

    // 스플래시 스크린을 위한 뷰 생성
    let splashView = UIView(frame: windowScene.coordinateSpace.bounds)
    splashView.backgroundColor = UIColor.white
    self.splashView = splashView

    // 스플래시 이미지 추가
    let splashImageView = UIImageView()
    splashImageView.image = UIImage(named: "LaunchImage")
    splashImageView.contentMode = .scaleAspectFit
    splashImageView.translatesAutoresizingMaskIntoConstraints = false
    splashView.addSubview(splashImageView)

    // 이미지를 화면 중앙에 배치하고 적절한 크기로 설정
    let screenWidth = windowScene.coordinateSpace.bounds.width
    let imageSize = min(screenWidth * 0.6, 400) // 화면 너비의 60% 또는 최대 400pt

    NSLayoutConstraint.activate([
      splashImageView.centerXAnchor.constraint(equalTo: splashView.centerXAnchor),
      splashImageView.centerYAnchor.constraint(equalTo: splashView.centerYAnchor),
      splashImageView.widthAnchor.constraint(equalToConstant: imageSize),
      splashImageView.heightAnchor.constraint(equalToConstant: imageSize)
    ])

    // React Native 부팅 (rootViewController 설정 + makeKeyAndVisible)
    factory.startReactNative(
      withModuleName: "ra-ising-app",
      in: window,
      launchOptions: nil
    )

    // RN 루트 뷰 위에 스플래시를 잠깐 덮었다가 페이드 아웃
    window.addSubview(splashView)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
      UIView.animate(withDuration: 0.3, animations: {
        self.splashView?.alpha = 0
      }) { _ in
        self.splashView?.removeFromSuperview()
        self.splashView = nil
      }
    }

    // 콜드 스타트 시 딥링크(raisingapp://oauth/...) 전달
    for context in connectionOptions.urlContexts {
      postOpenURL(context.url)
    }
  }

  // 앱이 떠 있는 상태에서 커스텀 스킴 딥링크로 복귀할 때(예: OAuth 리다이렉트)
  func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
    for context in URLContexts {
      postOpenURL(context.url)
    }
  }

  // 커스텀 스킴 딥링크(raisingapp://oauth/...) → RN Linking으로 전달. JS(App.tsx)에서 처리.
  // RCTLinkingManager가 RCTOpenURLNotification 옵저버를 등록해두므로, 그 노티만 쏘면 JS Linking의
  // 'url' 이벤트로 전달된다(정적 라이브러리 빌드에서 React_RCTLinking 모듈 임포트 불필요).
  private func postOpenURL(_ url: URL) {
    NotificationCenter.default.post(
      name: NSNotification.Name("RCTOpenURLNotification"),
      object: nil,
      userInfo: ["url": url.absoluteString]
    )
  }
}

class ReactNativeDelegate: RCTDefaultReactNativeFactoryDelegate {
  override func sourceURL(for bridge: RCTBridge) -> URL? {
    self.bundleURL()
  }

  override func bundleURL() -> URL? {
#if DEBUG
    RCTBundleURLProvider.sharedSettings().jsBundleURL(forBundleRoot: "index")
#else
    Bundle.main.url(forResource: "main", withExtension: "jsbundle")
#endif
  }
}
