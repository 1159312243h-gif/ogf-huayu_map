import UIKit
import WebKit

@main final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        let window = UIWindow(frame: UIScreen.main.bounds)
        window.rootViewController = AtlasController()
        window.makeKeyAndVisible()
        self.window = window
        return true
    }
}
final class AtlasController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandlerWithReply, UIDocumentPickerDelegate {
    private let origin = "ogf-atlas.pages.dev"
    private let startURL = URL(string: "https://ogf-atlas.pages.dev/?app=native")!
    private var web: WKWebView!
    private var token: String?
    private var fileURL: URL?
    private var handle: FileHandle?
    private var expected: Int64 = 0
    private var received: Int64 = 0
    private var fileName = "华域地图数据"
    private var finishReply: ((Any?, String?) -> Void)?
    private let maximum: Int64 = 9007199254740991
    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = UIColor(red: 0.95, green: 0.97, blue: 0.96, alpha: 1)
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        config.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "huayuNative")
        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        web.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(web)
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor),
            web.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: view.safeAreaLayoutGuide.trailingAnchor)
        ])
        web.load(URLRequest(url: startURL))
    }
    private func trusted(_ url: URL?) -> Bool {
        guard let url else { return false }
        return url.scheme == "https" && url.host == origin && (url.port == nil || url.port == 443)
            && url.user == nil && url.password == nil
    }
    private func external(_ url: URL) {
        if url.scheme == "https" || url.scheme == "http" { UIApplication.shared.open(url) }
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        if navigationAction.targetFrame?.isMainFrame == false { decisionHandler(.allow); return }
        if trusted(url) { decisionHandler(.allow) }
        else { decisionHandler(.cancel); external(url) }
    }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = navigationAction.request.url { external(url) }
        return nil
    }
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { cancelExport() }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        if (error as NSError).code == NSURLErrorCancelled { return }
        let alert = UIAlertController(title: "暂时无法连接地图", message: "请检查网络。账号与共享资料仍保存在原来的线上服务中。", preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "重新连接", style: .default) { [weak self] _ in
            guard let self else { return }; self.web.load(URLRequest(url: self.startURL))
        })
        alert.addAction(UIAlertAction(title: "稍后重试", style: .cancel))
        if presentedViewController == nil { present(alert, animated: true) }
    }
    private func respond(_ reply: @escaping (Any?, String?) -> Void, ok: Bool, result: Any = NSNull(), error: String = "") {
        reply(ok ? ["ok": true, "result": result] : ["ok": false, "error": error], nil)
    }
    private func cancelExport() {
        try? handle?.close()
        handle = nil
        if let fileURL { try? FileManager.default.removeItem(at: fileURL.deletingLastPathComponent()) }
        fileURL = nil
        token = nil
        if let finishReply { respond(finishReply, ok: false, error: "保存已取消") }
        finishReply = nil
    }
    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage, replyHandler: @escaping (Any?, String?) -> Void) {
        let security = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, security.protocol == "https", security.host == origin,
            (security.port == 0 || security.port == 443), trusted(web.url),
            let body = message.body as? [String: Any], let action = body["action"] as? String else {
            respond(replyHandler, ok: false, error: "保存请求来源无效"); return
        }
        do {
            if action == "begin" {
                guard token == nil else { respond(replyHandler, ok: false, error: "请先完成当前保存"); return }
                guard let number = body["size"] as? NSNumber, number.int64Value >= 0, number.int64Value <= maximum else {
                    respond(replyHandler, ok: false, error: "文件大小无效"); return
                }
                expected = number.int64Value; received = 0
                let raw = String((body["name"] as? String ?? "华域地图数据").prefix(120))
                let unsafe = CharacterSet(charactersIn: "\\/:*?\"<>|").union(.controlCharacters)
                fileName = raw.components(separatedBy: unsafe).joined(separator: "-")
                if fileName.isEmpty || fileName.allSatisfy({$0 == "."}) { fileName = "华域地图数据" }
                let identity = UUID().uuidString
                let directory = FileManager.default.temporaryDirectory.appendingPathComponent("huayu-export-" + identity, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                let file = directory.appendingPathComponent(fileName)
                guard FileManager.default.createFile(atPath: file.path, contents: Data()) else { throw CocoaError(.fileWriteUnknown) }
                fileURL = file; handle = try FileHandle(forWritingTo: file); token = identity
                respond(replyHandler, ok: true, result: identity); return
            }
            guard let token, token == body["token"] as? String else { respond(replyHandler, ok: false, error: "保存任务已失效"); return }
            switch action {
            case "chunk":
                guard let encoded = body["data"] as? String, encoded.count <= 262144, let data = Data(base64Encoded: encoded),
                    received + Int64(data.count) <= expected, let handle else { throw CocoaError(.fileWriteUnknown) }
                try handle.write(contentsOf: data); received += Int64(data.count)
                respond(replyHandler, ok: true)
            case "finish":
                guard received == expected, let fileURL else { throw CocoaError(.fileWriteUnknown) }
                try handle?.close(); handle = nil
                guard presentedViewController == nil else { throw CocoaError(.fileWriteUnknown) }
                finishReply = replyHandler
                let picker = UIDocumentPickerViewController(forExporting: [fileURL], asCopy: true)
                picker.delegate = self
                present(picker, animated: true)
            case "cancel":
                cancelExport(); respond(replyHandler, ok: true)
            default: respond(replyHandler, ok: false, error: "未知保存操作")
            }
        } catch { cancelExport(); respond(replyHandler, ok: false, error: "文件保存失败，请重试") }
    }
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        let callback = finishReply; finishReply = nil
        if let callback { respond(callback, ok: true, result: ["cancelled": false]) }
        cancelExport()
    }
    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let callback = finishReply; finishReply = nil
        if let callback { respond(callback, ok: true, result: ["cancelled": true]) }
        cancelExport()
    }
    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = UIAlertController(title: "华域地图", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler() })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = UIAlertController(title: "华域地图", message: message, preferredStyle: .alert)
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(false) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(true) })
        present(alert, animated: true)
    }
    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String, defaultText: String?, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (String?) -> Void) {
        let alert = UIAlertController(title: "华域地图", message: prompt, preferredStyle: .alert)
        alert.addTextField { field in field.text = defaultText; field.isSecureTextEntry = prompt.contains("密码") }
        alert.addAction(UIAlertAction(title: "取消", style: .cancel) { _ in completionHandler(nil) })
        alert.addAction(UIAlertAction(title: "确定", style: .default) { _ in completionHandler(alert.textFields?.first?.text) })
        present(alert, animated: true)
    }
}
