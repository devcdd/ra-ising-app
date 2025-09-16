import UIKit
import React
import React_RCTAppDelegate
import ReactAppDependencyProvider

@main
class AppDelegate: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  var splashView: UIView?

  var reactNativeDelegate: ReactNativeDelegate?
  var reactNativeFactory: RCTReactNativeFactory?

  func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
  ) -> Bool {
    // 스플래시 스크린을 위한 뷰 생성
    splashView = UIView(frame: UIScreen.main.bounds)
    splashView?.backgroundColor = UIColor.white
    
    // 스플래시 이미지 추가
    let splashImageView = UIImageView()
    splashImageView.image = UIImage(named: "LaunchImage")
    splashImageView.contentMode = .scaleAspectFit
    splashImageView.translatesAutoresizingMaskIntoConstraints = false
    splashView?.addSubview(splashImageView)
    
    // 이미지를 화면 중앙에 배치하고 적절한 크기로 설정
    let screenWidth = UIScreen.main.bounds.width
    let imageSize = min(screenWidth * 0.6, 400) // 화면 너비의 60% 또는 최대 400pt
    
    NSLayoutConstraint.activate([
      splashImageView.centerXAnchor.constraint(equalTo: splashView!.centerXAnchor),
      splashImageView.centerYAnchor.constraint(equalTo: splashView!.centerYAnchor),
      splashImageView.widthAnchor.constraint(equalToConstant: imageSize),
      splashImageView.heightAnchor.constraint(equalToConstant: imageSize)
    ])
    
    let delegate = ReactNativeDelegate()
    let factory = RCTReactNativeFactory(delegate: delegate)
    delegate.dependencyProvider = RCTAppDependencyProvider()

    reactNativeDelegate = delegate
    reactNativeFactory = factory

    window = UIWindow(frame: UIScreen.main.bounds)
    
    // 스플래시 뷰를 먼저 표시
    window?.rootViewController = UIViewController()
    window?.rootViewController?.view = splashView
    window?.makeKeyAndVisible()
    
    // React Native 로드 완료 후 스플래시 뷰 제거 (1초 후)
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
      UIView.animate(withDuration: 0.3, animations: {
        self.splashView?.alpha = 0
      }) { _ in
        self.splashView?.removeFromSuperview()
        self.splashView = nil
      }
    }

    factory.startReactNative(
      withModuleName: "ra-ising-app",
      in: window,
      launchOptions: launchOptions
    )

    return true
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
