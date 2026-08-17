// Menu bar controller for Mac Developer Bridge (Cloudflare/HTTP transport).
//
// It owns the lifecycle of the two processes the transport needs — mcp-http.mjs
// and `cloudflared tunnel` — and surfaces the three things you actually need:
// the public URL, the bearer token, and whether the endpoint is answering.
//
// Owning the lifecycle is the point. The scripted kill switch has to discover
// processes it did not start, which is where its bugs came from; this app knows
// its own children. "Stop" also removes the unlock file, so bridge.mjs's
// per-call latch refuses anything already in flight.

import AppKit

// MARK: - Paths and shell resolution

/// GUI apps launched from Finder get a minimal PATH — no nvm, no Homebrew — so
/// every external binary is resolved through a login shell exactly as the bridge
/// itself does. Resolving `node` from the app's own PATH would fail on any
/// version-managed install.
func loginShellResolve(_ tool: String) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "command -v \(tool)"]
    let out = Pipe()
    p.standardOutput = out
    // nullDevice, not a Pipe: an unread stderr pipe blocks the shell once it fills
    // (~64 KB), so a chatty .zprofile — nvm, pyenv, brew warnings — would hang this
    // call forever while we block reading stdout, and the app would never appear.
    p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    // Last non-empty line, and it must actually be an executable. A profile that
    // prints anything (a greeting, an nvm notice) otherwise becomes part of the
    // "path", leaving nodePath non-nil so startup looks healthy and Start fails with
    // an opaque spawn error instead.
    let path = String(decoding: data, as: UTF8.self)
        .split(separator: "\n")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .last(where: { !$0.isEmpty }) ?? ""
    guard !path.isEmpty, FileManager.default.isExecutableFile(atPath: path) else { return nil }
    return path
}

struct Paths {
    /// Where mcp-http.mjs and bridge.mjs live.
    ///
    /// Resolved in three steps so the bundle can be installed to /Applications while
    /// the package stays where it is. Requiring the app to sit INSIDE the package meant
    /// it could only live in ~/Downloads, where nobody looks for an app and Launchpad
    /// never shows it.
    static let packageDir: String = {
        let fm = FileManager.default
        func hasBridge(_ dir: String) -> Bool { fm.fileExists(atPath: dir + "/mcp-http.mjs") }

        // 1. Explicit override, for development.
        if let override = ProcessInfo.processInfo.environment["MAC_DEV_BRIDGE_HOME"],
           !override.isEmpty, hasBridge(override) {
            return override
        }
        // 2. Next to the bundle — true when run in place from the package.
        let sibling = (Bundle.main.bundlePath as NSString).deletingLastPathComponent
        if hasBridge(sibling) { return sibling }
        // 3. The path baked in at build time, so an installed copy still finds it.
        if let baked = Bundle.main.object(forInfoDictionaryKey: "MDBPackageDirectory") as? String,
           !baked.isEmpty, hasBridge(baked) {
            return baked
        }
        // Nothing found: return the sibling so the error names a real path.
        return sibling
    }()

    static var frontEnd: String { packageDir + "/mcp-http.mjs" }

    static let dataDir: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ProcessInfo.processInfo.environment["MAC_DEV_BRIDGE_DATA_DIR"]
            ?? home + "/Library/Application Support/MacDeveloperBridge"
    }()

    static let logDir: String = {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        return ProcessInfo.processInfo.environment["MAC_DEV_BRIDGE_LOG_DIR"]
            ?? home + "/Library/Logs/MacDeveloperBridge"
    }()

    static var tokenFile: String { dataDir + "/http-token" }
    static var tunnelPidFile: String { dataDir + "/cloudflared.pid" }
    static var clientIdFile: String { dataDir + "/oauth-client-id" }
    static var unlockFile: String { dataDir + "/FULL_ACCESS_ENABLED" }
    static var settingsFile: String { dataDir + "/settings.json" }
    static var httpLog: String { logDir + "/http.stderr.log" }
    static var tunnelLog: String { logDir + "/tunnel.stderr.log" }
}

let fullAccessAck = "I_UNDERSTAND_THIS_GRANTS_FULL_ACCESS"

/// A named Cloudflare tunnel, if one is configured.
///
/// This matters more than it looks: `cloudflared tunnel --url` mints a NEW random
/// hostname on every start, so the Server URL changes each run and a ChatGPT connector
/// has to be recreated every time. Worse, the OAuth issuer is that hostname — if the
/// bridge restarts between discovery and the callback, the issuer no longer matches
/// what the client recorded and a strict client drops the callback silently.
///
/// The configuration is read from cloudflared's OWN config file rather than duplicated
/// into a second format, so there is one source of truth for which tunnel and hostname
/// are in use.
struct NamedTunnel {
    let name: String
    let hostname: String
    var publicURL: String { "https://\(hostname)" }

    /// Trim a scalar the way the two keys we read can legitimately appear: an inline
    /// `# comment`, and surrounding single or double quotes. Neither a tunnel name nor a
    /// hostname can contain `#` or a quote, so this cannot corrupt a valid value — and
    /// without it, `tunnel: "cos-dev"` became the literal `"cos-dev"` and
    /// `hostname: x # note` became `x # note`.
    private static func scalar(_ raw: some StringProtocol) -> String {
        var v = String(raw).trimmingCharacters(in: .whitespaces)
        if let hash = v.firstIndex(of: "#") {
            v = String(v[v.startIndex..<hash]).trimmingCharacters(in: .whitespaces)
        }
        for q in ["\"", "'"] where v.count >= 2 && v.hasPrefix(q) && v.hasSuffix(q) {
            v = String(v.dropFirst().dropLast())
        }
        return v.trimmingCharacters(in: .whitespaces)
    }

    static func fromCloudflaredConfig() -> NamedTunnel? {
        let home = FileManager.default.homeDirectoryForCurrentUser.path
        for path in ["\(home)/.cloudflared/config.yml", "\(home)/.cloudflared/config.yaml"] {
            guard let text = try? String(contentsOfFile: path, encoding: .utf8) else { continue }
            var name: String?
            var hostname: String?
            // Deliberately not a YAML parser: two keys from a file this project does not
            // own. Anything more ambitious would be guessing at a schema cloudflared
            // controls. If either key is missing we fall back to a quick tunnel.
            for raw in text.split(separator: "\n") {
                let line = raw.trimmingCharacters(in: .whitespaces)
                if line.hasPrefix("#") { continue }
                if name == nil, line.hasPrefix("tunnel:") {
                    name = scalar(line.dropFirst("tunnel:".count))
                }
                if hostname == nil, line.hasPrefix("- hostname:") || line.hasPrefix("hostname:") {
                    let v = line.contains("- hostname:")
                        ? line.dropFirst("- hostname:".count)
                        : line.dropFirst("hostname:".count)
                    hostname = scalar(v)
                }
            }
            if let name, let hostname, !name.isEmpty, !hostname.isEmpty {
                return NamedTunnel(name: name, hostname: hostname)
            }
        }
        return nil
    }
}
let httpPort = Int(ProcessInfo.processInfo.environment["MAC_DEV_BRIDGE_HTTP_PORT"] ?? "") ?? 8787

// MARK: - Token

enum TokenStore {
    /// Generated once and reused, mode 0600. Passed to the front end by FILE
    /// rather than environment, so it stays out of `ps eww` output.
    static func loadOrCreate() throws -> String {
        let fm = FileManager.default
        try fm.createDirectory(atPath: Paths.dataDir, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        // Repair the directory mode: passing attributes to createDirectory is a no-op
        // when the directory already exists, and mcp-http.mjs may have created it 0755.
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: Paths.dataDir)

        if let existing = try? String(contentsOfFile: Paths.tokenFile, encoding: .utf8) {
            let trimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
            // Match the consumer exactly: mcp-http.mjs requires >= 24 BYTES of
            // printable ASCII and exits 78 otherwise. Counting Characters accepted a
            // 24-emoji token that the front end then rejected, surfacing only as an
            // opaque "exited (code 78)".
            if trimmed.utf8.count >= 24, trimmed.allSatisfy({ $0.isASCII && $0 != " " && $0.asciiValue.map { $0 > 0x20 && $0 < 0x7f } == true }) {
                try? fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.tokenFile)
                return trimmed
            }
        }
        var bytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else {
            throw NSError(domain: "MacDevBridge", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Could not generate a token"])
        }
        let token = bytes.map { String(format: "%02x", $0) }.joined()
        // Create empty at 0600 first, then write in place. An atomic write followed by
        // chmod leaves the token world-readable in between, and rotation reopens that
        // window every time.
        try? fm.removeItem(atPath: Paths.tokenFile)
        fm.createFile(atPath: Paths.tokenFile, contents: nil, attributes: [.posixPermissions: 0o600])
        guard let handle = FileHandle(forWritingAtPath: Paths.tokenFile) else {
            throw NSError(domain: "MacDevBridge", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "Could not open the token file for writing"])
        }
        handle.write(Data(token.utf8))
        try? handle.close()
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.tokenFile)
        return token
    }
}

enum OperatorSettingsStore {
    static func strictApprovals() -> Bool {
        guard let data = FileManager.default.contents(atPath: Paths.settingsFile),
              let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              let value = dictionary["strictApprovals"] as? Bool
        else { return false }
        return value
    }

    static func setStrictApprovals(_ enabled: Bool) throws {
        let fm = FileManager.default
        try fm.createDirectory(atPath: Paths.dataDir, withIntermediateDirectories: true,
                               attributes: [.posixPermissions: 0o700])
        try? fm.setAttributes([.posixPermissions: 0o700], ofItemAtPath: Paths.dataDir)

        var dictionary: [String: Any] = [:]
        if let existing = fm.contents(atPath: Paths.settingsFile),
           let object = try? JSONSerialization.jsonObject(with: existing),
           let parsed = object as? [String: Any] {
            dictionary = parsed
        }
        dictionary["strictApprovals"] = enabled
        let data = try JSONSerialization.data(withJSONObject: dictionary, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: URL(fileURLWithPath: Paths.settingsFile), options: .atomic)
        try fm.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.settingsFile)
    }
}

enum ClientIdStore {
    /// Stable across restarts, because ChatGPT stores it in the connector config —
    /// regenerating it on every launch would silently break an existing connection.
    static func loadOrCreate() -> String {
        if let existing = try? String(contentsOfFile: Paths.clientIdFile, encoding: .utf8) {
            let trimmed = existing.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty { return trimmed }
        }
        var bytes = [UInt8](repeating: 0, count: 8)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        let id = "mdb-" + bytes.map { String(format: "%02x", $0) }.joined()
        try? id.write(toFile: Paths.clientIdFile, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.clientIdFile)
        return id
    }
}

// MARK: - Controller

enum BridgeState {
    case stopped
    case starting
    case running
    case failed(String)
}

final class Controller: NSObject, NSApplicationDelegate {
    private var statusItem: NSStatusItem!
    private let menu = NSMenu()

    private var httpProcess: Process?
    private var tunnelProcess: Process?
    private var tunnelReader: FileHandle?

    private var token = ""
    private var publicURL: String?
    private var state: BridgeState = .stopped
    private var pollTimer: Timer?

    private var nodePath: String?
    private var cloudflaredPath: String?
    private var clientId = ""
    private var namedTunnel: NamedTunnel?
    /// Front end launch is deferred until the tunnel hostname is known, so the OAuth
    /// issuer can be PINNED to the public origin rather than derived from the Host
    /// header on each request. Host is client-controllable; a pinned issuer cannot be
    /// steered by a crafted request into advertising someone else's endpoints.
    private var pendingFrontEndLaunch = false
    private var startGeneration = 0

    // Menu items kept as properties so polling can retitle them in place.
    private let statusMenuItem = NSMenuItem(title: "Stopped", action: nil, keyEquivalent: "")
    private let urlMenuItem = NSMenuItem(title: "No URL yet", action: nil, keyEquivalent: "")
    private let tokenMenuItem = NSMenuItem(title: "Token: —", action: nil, keyEquivalent: "")
    private let clientIdMenuItem = NSMenuItem(title: "OAuth Client ID: —", action: nil, keyEquivalent: "")
    private let tunnelModeMenuItem = NSMenuItem(title: "Tunnel: —", action: nil, keyEquivalent: "")
    private let startStopItem = NSMenuItem(title: "Start", action: nil, keyEquivalent: "")
    private let strictApprovalsItem = NSMenuItem(title: "Strict approvals", action: nil, keyEquivalent: "")

    /// Reclaim anything a previous instance left behind.
    ///
    /// `applicationWillTerminate` does not run on force-quit, a crash, or a hard
    /// reboot — so a previous run can leave the unlock file armed and the front
    /// end serving a public endpoint with nothing supervising it. Worse, the next
    /// Start would spawn a second front end that dies on EADDRINUSE while the
    /// orphan keeps answering. Establish a known-stopped baseline instead.
    private func reclaimOrphans() {
        // Disarm first: whatever else is true, an unattended bridge should not be
        // able to serve another tool call.
        try? FileManager.default.removeItem(atPath: Paths.unlockFile)

        // The tunnel is reclaimed first and separately, because it has its own
        // pidfile and a surviving cloudflared keeps a PUBLIC hostname pointed at this
        // machine. Reclaiming only the front end left that ingress open permanently:
        // the next Start re-armed it and added a second tunnel, and no Stop could ever
        // close the first, because stopBridge only knows its own children.
        reclaimRecordedProcess(pidFile: Paths.tunnelPidFile, mustContain: "cloudflared")

        let pidFile = Paths.dataDir + "/mcp-http.pid"
        guard let raw = try? String(contentsOfFile: pidFile, encoding: .utf8),
              let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 1
        else { return }

        // Confirm identity before signalling: pids are recycled, and the pidfile
        // is not removed on SIGKILL or reboot.
        let check = Process()
        check.executableURL = URL(fileURLWithPath: "/bin/ps")
        check.arguments = ["-o", "command=", "-p", String(pid)]
        let out = Pipe()
        check.standardOutput = out
        check.standardError = FileHandle.nullDevice
        guard (try? check.run()) != nil else { return }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        check.waitUntilExit()
        let command = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        // Positional check, not a substring. A command line that merely MENTIONS the
        // filename — `node --check mcp-http.mjs`, a tail of a log path, another
        // checkout — is not our front end, and pids get recycled while this pidfile
        // survives SIGKILL and reboot. Require the script to be what the interpreter
        // is actually running: directly after it, with only dash-flags between.
        guard Self.looksLikeFrontEnd(pid: pid, commandLine: command) else {
            // Do NOT delete the record here. A false negative used to erase the only
            // handle on a live front end; keeping it lets the next launch retry.
            NSLog("MacDevBridge: pidfile %d does not look like our front end; leaving the record alone", pid)
            return
        }

        // Group-signal, so bridge.mjs under an orphaned front end dies with it.
        if kill(-pid, SIGTERM) != 0 { kill(pid, SIGTERM) }
        let deadline = Date().addingTimeInterval(2)
        while kill(pid, 0) == 0 && Date() < deadline { usleep(50_000) }
        if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
        try? FileManager.default.removeItem(atPath: pidFile)
        reclaimedOrphan = true
    }

    private var reclaimedOrphan = false

    /// Stop a process recorded in a pidfile, after confirming it really is that
    /// program. Pids get recycled and these pidfiles survive SIGKILL and reboot, so
    /// signalling on the pidfile alone can kill an unrelated process.
    private func reclaimRecordedProcess(pidFile: String, mustContain: String) {
        // Deliberately NOT a blanket `defer` delete. Removing the record when the
        // identity check or `ps` merely FAILED left a live process with nothing
        // pointing at it — the unreclaimable-tunnel case this function exists to
        // prevent. Delete only once the pid is confirmed dead or confirmed not ours.
        func forget() { try? FileManager.default.removeItem(atPath: pidFile) }
        guard let raw = try? String(contentsOfFile: pidFile, encoding: .utf8),
              let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
              pid > 1
        else { forget(); return }          // unusable record
        guard kill(pid, 0) == 0 else { forget(); return }   // already gone

        let check = Process()
        check.executableURL = URL(fileURLWithPath: "/bin/ps")
        check.arguments = ["-o", "comm=", "-p", String(pid)]
        let out = Pipe()
        check.standardOutput = out
        check.standardError = FileHandle.nullDevice
        guard (try? check.run()) != nil else { return }   // keep the record; retry later
        let data = out.fileHandleForReading.readDataToEndOfFile()
        check.waitUntilExit()
        // Match the EXECUTABLE, not the whole command line. A substring test killed a
        // `tail -f cloudflared.log`, and would match an unrelated cloudflared tunnel
        // the user runs for another service.
        let comm = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        guard (comm as NSString).lastPathComponent == mustContain else { forget(); return }

        // Signal the group: the recorded pid is a group leader, and its children
        // (bridge.mjs under the front end) must not outlive it.
        if kill(-pid, SIGTERM) != 0 { kill(pid, SIGTERM) }
        let deadline = Date().addingTimeInterval(2)
        while kill(pid, 0) == 0 && Date() < deadline { usleep(50_000) }
        if kill(pid, 0) == 0, kill(-pid, SIGKILL) != 0 { kill(pid, SIGKILL) }
        forget()
        reclaimedOrphan = true
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        buildMenu()
        statusItem.menu = menu

        reclaimOrphans()

        nodePath = loginShellResolve("node")
        cloudflaredPath = loginShellResolve("cloudflared")
        namedTunnel = NamedTunnel.fromCloudflaredConfig()

        do { token = try TokenStore.loadOrCreate() } catch {
            state = .failed("token: \(error.localizedDescription)")
        }
        clientId = ClientIdStore.loadOrCreate()

        if !FileManager.default.fileExists(atPath: Paths.frontEnd) {
            state = .failed("mcp-http.mjs not found next to the app")
        } else if nodePath == nil {
            state = .failed("node not found on the login shell PATH")
        }

        render()
        let timer = Timer(timeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.poll()
        }
        // .common, not the default mode: NSMenu tracking runs the run loop in
        // NSEventTrackingRunLoopMode, so a default-mode timer freezes the status line
        // precisely while the menu is open and being read.
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    func applicationWillTerminate(_ notification: Notification) {
        stopBridge(blocking: true)
        // Sweep by pidfile as well. After a menu Stop the process refs are already
        // nil, so the blocking stop above has nothing to escalate — but a draining
        // cloudflared may still be alive, and this is the last moment we can reach it.
        reclaimRecordedProcess(pidFile: Paths.tunnelPidFile, mustContain: "cloudflared")
    }

    // MARK: Menu

    private func buildMenu() {
        statusMenuItem.isEnabled = false
        menu.addItem(statusMenuItem)
        tunnelModeMenuItem.isEnabled = false
        menu.addItem(tunnelModeMenuItem)
        menu.addItem(.separator())

        urlMenuItem.target = self
        urlMenuItem.action = #selector(copyURL)
        menu.addItem(urlMenuItem)

        clientIdMenuItem.target = self
        clientIdMenuItem.action = #selector(copyClientId)
        menu.addItem(clientIdMenuItem)

        let setup = NSMenuItem(title: "Copy ChatGPT Setup", action: #selector(copySetup), keyEquivalent: "c")
        setup.target = self
        menu.addItem(setup)

        // Kept, but demoted and labelled: ChatGPT's dialog has no field for it. It is
        // the consent credential for the OAuth flow, and the auth method for any other
        // Bearer-capable MCP client.
        tokenMenuItem.target = self
        tokenMenuItem.action = #selector(copyToken)
        menu.addItem(tokenMenuItem)

        menu.addItem(.separator())

        startStopItem.target = self
        startStopItem.action = #selector(toggleBridge)
        menu.addItem(startStopItem)

        strictApprovalsItem.target = self
        strictApprovalsItem.action = #selector(toggleStrictApprovals)
        strictApprovalsItem.toolTip = "Off by default: MDB can use the signed-in Chrome profile and foreground apps without per-site/per-app approval files. Turn this on to require short-lived scoped approvals."
        menu.addItem(strictApprovalsItem)

        let regen = NSMenuItem(title: "Rotate Token…", action: #selector(rotateToken), keyEquivalent: "")
        regen.target = self
        menu.addItem(regen)

        menu.addItem(.separator())

        let logs = NSMenuItem(title: "Open Logs", action: #selector(openLogs), keyEquivalent: "")
        logs.target = self
        menu.addItem(logs)

        let reveal = NSMenuItem(title: "Reveal Package in Finder", action: #selector(revealPackage), keyEquivalent: "")
        reveal.target = self
        menu.addItem(reveal)

        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit (stops the bridge)", action: #selector(quit), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
    }

    private func render() {
        let symbol: String
        var description: String
        switch state {
        case .stopped:
            symbol = "moon.zzz"
            description = "Stopped"
        case .starting:
            symbol = "arrow.triangle.2.circlepath"
            description = "Starting…"
        case .running:
            symbol = "bolt.horizontal.circle.fill"
            description = publicURL == nil
                ? "Running on :\(httpPort) — public URL not detected yet"
                : "Running on :\(httpPort)"
        case .failed(let why):
            symbol = "exclamationmark.triangle.fill"
            description = "Problem: \(why)"
        }

        if let image = NSImage(systemSymbolName: symbol, accessibilityDescription: description) {
            image.isTemplate = true
            statusItem.button?.image = image
            statusItem.button?.title = ""
        } else {
            statusItem.button?.title = "MDB"
        }
        statusItem.button?.toolTip = "Mac Developer Bridge — \(description)"

        let mode = namedTunnel.map { "stable: \($0.hostname)" } ?? "quick tunnel — URL changes every start"
        tunnelModeMenuItem.title = "Tunnel: \(mode)"
        statusMenuItem.title = reclaimedOrphan && publicURL == nil
            ? description + " (stopped an orphan from a previous run)"
            : description
        urlMenuItem.title = publicURL.map { "Copy Server URL: \($0)/mcp" }
            ?? "No URL yet — waiting for cloudflared"
        urlMenuItem.isEnabled = publicURL != nil
        tokenMenuItem.title = token.isEmpty
            ? "Token: —"
            : "Copy Bearer Token (consent + non-ChatGPT clients)"
        tokenMenuItem.isEnabled = !token.isEmpty
        clientIdMenuItem.title = clientId.isEmpty ? "OAuth Client ID: —" : "Copy OAuth Client ID: \(clientId)"
        clientIdMenuItem.isEnabled = !clientId.isEmpty

        switch state {
        case .running, .starting: startStopItem.title = "Stop"
        default: startStopItem.title = "Start"
        }
        strictApprovalsItem.state = OperatorSettingsStore.strictApprovals() ? .on : .off
        strictApprovalsItem.title = "Strict approvals"
    }

    // MARK: Actions

    @objc private func toggleBridge() {
        switch state {
        case .running, .starting: stopBridge()
        default: startBridge()
        }
        render()
    }

    @objc private func toggleStrictApprovals() {
        let enabled = !OperatorSettingsStore.strictApprovals()
        do {
            try OperatorSettingsStore.setStrictApprovals(enabled)
            render()
            if enabled {
                notify("Strict approvals enabled", "Websites and foreground app control now require scoped short-lived approvals.")
            } else {
                notify("Relaxed access enabled", "MDB can execute through the signed-in Chrome profile and apps without per-site/per-app approval commands.")
            }
        } catch {
            notify("Could not update approval mode", error.localizedDescription)
        }
    }

    @objc private func copyURL() {
        guard let url = publicURL else { return }
        write(toClipboard: url + "/mcp")
        notify("Copied", url + "/mcp")
    }

    @objc private func copyToken() {
        guard !token.isEmpty else { return }
        write(toClipboard: token)
        notify("Copied bearer token", "Paste on the consent page, or use with a Bearer-capable client.")
    }

    @objc private func copyClientId() {
        guard !clientId.isEmpty else { return }
        write(toClipboard: clientId)
        notify("Copied OAuth Client ID", "Goes in ChatGPT's OAuth Client ID field.")
    }

    /// Everything needed to fill in ChatGPT's New Plugin dialog, in order.
    @objc private func copySetup() {
        guard let url = publicURL else {
            notify("No public URL yet", "Press Start and wait for cloudflared.")
            return
        }
        let text = """
        ChatGPT → Plugins → + → New Plugin

        Connection:            Server URL
        Server URL:            \(url)/mcp
        Authentication:        OAuth
        Registration method:   User-Defined OAuth Client
        OAuth Client ID:       \(clientId)
        OAuth Client Secret:   (leave blank)
        Token endpoint auth:   none
        Default scopes:        mcp
        OIDC enabled:          UNTICK IT

        Untick OIDC: /.well-known/openid-configuration is served only as an alias of
        the OAuth metadata and omits every signing and subject field, so no ID token
        is issued. Leaving it on invites ChatGPT to request scopes we do not advertise.

        Tick "I understand and want to continue", then Create.

        ChatGPT opens a consent page in your browser. It asks for this machine's
        bearer token, which is how it knows the approval came from you:
          \(token)

        Keep that token private. It also authorizes this endpoint directly for any
        client that can send an Authorization: Bearer header.
        """
        write(toClipboard: text)
        notify("Copied ChatGPT setup", "Paste it somewhere and work down the list.")
    }

    @objc private func rotateToken() {
        let alert = NSAlert()
        alert.messageText = "Rotate the bearer token?"
        alert.informativeText = "The current token stops working immediately. You will have to paste the new one into the ChatGPT plugin. The bridge restarts if it is running."
        alert.addButton(withTitle: "Rotate")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }

        let wasRunning: Bool
        switch state {
        case .running, .starting: wasRunning = true
        default: wasRunning = false
        }
        stopBridge()
        try? FileManager.default.removeItem(atPath: Paths.tokenFile)
        do { token = try TokenStore.loadOrCreate() } catch {
            token = ""   // the old one is already deleted; never hand it out again
            state = .failed("token: \(error.localizedDescription)")
        }
        if wasRunning && !token.isEmpty { startBridge() }
        render()
    }

    @objc private func openLogs() {
        NSWorkspace.shared.selectFile(Paths.httpLog, inFileViewerRootedAtPath: Paths.logDir)
    }

    @objc private func revealPackage() {
        NSWorkspace.shared.selectFile(Paths.frontEnd, inFileViewerRootedAtPath: Paths.packageDir)
    }

    @objc private func quit() {
        // Only terminate. applicationWillTerminate does the single blocking stop;
        // stopping here first nils the process refs, leaving that stop nothing to
        // escalate against — the SIGKILL fallback was dead code on this path.
        NSApp.terminate(nil)
    }

    private func write(toClipboard text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
    }

    private func notify(_ title: String, _ body: String) {
        // Deliberately not UNUserNotificationCenter: that requires an authorized,
        // signed bundle. The tooltip and menu titles already carry the state.
        statusItem.button?.toolTip = "\(title) — \(body)"
    }

    // MARK: Lifecycle

    private func startBridge() {
        guard nodePath != nil else {
            state = .failed("node not found on the login shell PATH")
            return
        }
        guard FileManager.default.fileExists(atPath: Paths.frontEnd) else {
            state = .failed("mcp-http.mjs not found next to the app")
            return
        }
        guard !token.isEmpty else {
            state = .failed("no token")
            return
        }
        guard let cf = cloudflaredPath else {
            state = .failed("cloudflared not found on the login shell PATH")
            return
        }

        stopBridge()
        startGeneration += 1
        state = .starting
        publicURL = nil
        pendingFrontEndLaunch = true

        // Arm the latch. Stop removes it again, which is what makes stopping
        // fail-closed rather than merely killing a process.
        try? FileManager.default.createDirectory(atPath: Paths.dataDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])
        try? FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: Paths.dataDir)
        try? (fullAccessAck + "\n").write(toFile: Paths.unlockFile, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.unlockFile)
        try? FileManager.default.createDirectory(atPath: Paths.logDir, withIntermediateDirectories: true,
                                                attributes: [.posixPermissions: 0o700])

        // The tunnel starts FIRST. cloudflared does not require its origin to be up,
        // and knowing the hostname before launching the front end is what lets the
        // OAuth issuer be pinned to the real public origin.
        let tunnel = Process()
        tunnel.executableURL = URL(fileURLWithPath: cf)
        if let named = namedTunnel {
            // `tunnel run <name>` uses the ingress rules in cloudflared's config, so the
            // port comes from there rather than being passed here.
            tunnel.arguments = ["tunnel", "--no-autoupdate", "run", named.name]
        } else {
            tunnel.arguments = ["tunnel", "--url", "http://127.0.0.1:\(httpPort)", "--no-autoupdate"]
        }
        tunnel.environment = childEnvironment(publicURL: nil)
        let pipe = Pipe()
        tunnel.standardOutput = pipe
        tunnel.standardError = pipe
        do { try tunnel.run() } catch {
            stopBridge()
            state = .failed("cloudflared: \(error.localizedDescription)")
            return
        }
        tunnelProcess = tunnel
        try? String(tunnel.processIdentifier).write(toFile: Paths.tunnelPidFile, atomically: true, encoding: .utf8)
        try? FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: Paths.tunnelPidFile)
        readTunnelOutput(pipe)

        if let named = namedTunnel {
            // The hostname is already known, so the front end starts immediately with the
            // issuer pinned. No output scraping, and no chance of sitting in "Starting…"
            // because a quick tunnel never announced a URL.
            publicURL = named.publicURL
            launchFrontEnd(publicURL: named.publicURL)
        } else {
            // Quick tunnel: the hostname only exists in cloudflared's output. Fail loudly
            // rather than waiting forever if it never appears.
            let generation = startGeneration
            DispatchQueue.main.asyncAfter(deadline: .now() + 45) { [weak self] in
                guard let self, self.startGeneration == generation, self.pendingFrontEndLaunch else { return }
                self.stopBridge()
                self.state = .failed("cloudflared produced no hostname in 45s — see Open Logs")
                self.render()
            }
        }
    }

    /// Environment shared by both children. `publicURL` is nil for cloudflared, which
    /// does not need it, and set for the front end so the OAuth issuer is pinned.
    private func childEnvironment(publicURL: String?) -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        env["MAC_DEV_BRIDGE_HTTP_TOKEN_FILE"] = Paths.tokenFile
        env["MAC_DEV_BRIDGE_HTTP_PORT"] = String(httpPort)
        env["MAC_DEV_BRIDGE_DATA_DIR"] = Paths.dataDir
        env["MAC_DEV_BRIDGE_LOG_DIR"] = Paths.logDir
        env["MAC_DEV_BRIDGE_UNLOCK_FILE"] = Paths.unlockFile
        env["MAC_DEV_BRIDGE_OAUTH_CLIENT_ID"] = clientId
        if let publicURL { env["MAC_DEV_BRIDGE_PUBLIC_URL"] = publicURL }
        // Never inherit the env-var form of the acknowledgement. bridge.mjs treats it as
        // a standing unlock, so a bridge started with it set cannot be revoked by
        // removing the unlock file — which would void this app's entire Stop contract.
        env.removeValue(forKey: "MAC_DEV_BRIDGE_FULL_ACCESS_ACK")
        // A GUI-launched app has a minimal PATH; give children the login one so
        // shell_exec behaves the same as it does from a terminal.
        if let shellPath = loginShellPATH() { env["PATH"] = shellPath }
        return env
    }

    /// Launch the front end once the public origin is known.
    private func launchFrontEnd(publicURL url: String) {
        guard pendingFrontEndLaunch, let node = nodePath else { return }
        pendingFrontEndLaunch = false

        let http = Process()
        http.executableURL = URL(fileURLWithPath: node)
        http.arguments = [Paths.frontEnd]
        http.environment = childEnvironment(publicURL: url)
        http.standardOutput = appendHandle(Paths.logDir + "/http.stdout.log")
        http.standardError = appendHandle(Paths.httpLog)
        do { try http.run() } catch {
            stopBridge()
            state = .failed("front end: \(error.localizedDescription)")
            render()
            return
        }
        httpProcess = http
        render()
    }

    /// Signal a process group, refusing any target that is not a real pid.
    ///
    /// Foundation reports processIdentifier == 0 for a Process that never launched or
    /// failed to launch (measured), and `kill(-0, sig)` signals THIS app's own process
    /// group while `kill(-1, sig)` signals every process the user owns. The isRunning
    /// checks at the call sites should already prevent that; this makes it structural,
    /// because the downside is losing the user's session.
    private static func signalGroup(_ process: Process, _ sig: Int32) -> Bool {
        let pid = process.processIdentifier
        guard pid > 1 else { return false }
        if kill(-pid, sig) == 0 { return true }
        return kill(pid, sig) == 0   // fall back to the single process
    }

    private func stopBridge(blocking: Bool = false) {
        // Disarm first, so anything mid-flight is refused even before the
        // processes die.
        try? FileManager.default.removeItem(atPath: Paths.unlockFile)

        let doomed = [tunnelProcess, httpProcess].compactMap { $0 }
        // Captured before the refs are nil'd, so escalate deletes only its own record.
        let ownedTunnelPid: Int32? = tunnelProcess.map { $0.processIdentifier }.flatMap { $0 > 1 ? $0 : nil }
        for process in doomed where process.isRunning {
            // Signal the process GROUP. Foundation gives each child its own group, and
            // terminate() reaches only the direct child — so bridge.mjs's `zsh -lc`
            // grandchildren (an in-flight shell_exec, for instance) kept running after
            // Stop. Fall back to the single process if the group call fails.
            if !Self.signalGroup(process, SIGTERM) {
                process.terminate()
            }
        }

        let escalate = {
            let deadline = Date().addingTimeInterval(3)
            for process in doomed {
                while process.isRunning && Date() < deadline { usleep(50_000) }
                if process.isRunning { _ = Self.signalGroup(process, SIGKILL) }
            }
            // Compare-and-delete, and only for the tunnel this closure owned.
            //
            // Three bugs lived here. `allSatisfy` on an EMPTY doomed array is vacuously
            // true, so a Stop-then-Quit deleted the record of a still-draining tunnel.
            // A concurrent Start meant this closure erased the record of the NEW tunnel.
            // And `isRunning` is still true immediately after SIGKILL, so gating on it
            // leaked a stale record every escalation. Confirm death with kill(pid, 0),
            // and only remove the file if it still names the pid we just killed.
            if let tunnelPid = ownedTunnelPid {
                let deadline = Date().addingTimeInterval(1)
                while kill(tunnelPid, 0) == 0 && Date() < deadline { usleep(50_000) }
                if kill(tunnelPid, 0) != 0,
                   let recorded = try? String(contentsOfFile: Paths.tunnelPidFile, encoding: .utf8),
                   Int32(recorded.trimmingCharacters(in: .whitespacesAndNewlines)) == tunnelPid {
                    try? FileManager.default.removeItem(atPath: Paths.tunnelPidFile)
                }
            }
        }
        if blocking {
            escalate()
        } else {
            DispatchQueue.global(qos: .userInitiated).async(execute: escalate)
        }

        tunnelReader?.readabilityHandler = nil
        tunnelProcess = nil
        httpProcess = nil
        tunnelReader = nil
        publicURL = nil
        if case .failed = state {} else { state = .stopped }
    }

    /// cloudflared prints the assigned hostname to stderr; there is no flag to
    /// ask for it, so it is scraped from the stream.
    private func readTunnelOutput(_ pipe: Pipe) {
        let handle = pipe.fileHandleForReading
        tunnelReader = handle
        handle.readabilityHandler = { [weak self] fh in
            let data = fh.availableData
            guard !data.isEmpty else {
                fh.readabilityHandler = nil
                return
            }
            let text = String(decoding: data, as: UTF8.self)
            try? text.data(using: .utf8)?.append(toFile: Paths.tunnelLog)
            guard let self else { return }
            if let found = Self.firstTryCloudflareURL(in: text) {
                DispatchQueue.main.async {
                    if self.publicURL == nil {
                        self.publicURL = found
                        // The hostname is the trigger: the front end starts now, with the
                        // issuer pinned to this origin.
                        self.launchFrontEnd(publicURL: found)
                        self.render()
                    }
                }
            }
        }
    }

    /// True when `commandLine` is an interpreter RUNNING the named script: the script
    /// sits directly after the executable with only dash-flags between. Mere presence
    /// in argv is not enough — `node tests/http.mjs <path>/mcp-http.mjs` and
    /// `node --check mcp-http.mjs` both mention it without serving anything.
    /// The executable of `pid`, basename only. `ps -o comm=` gives the binary without
    /// arguments, so it cannot be confused by spaces in paths the way argv parsing can.
    static func executableName(of pid: Int32) -> String? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/bin/ps")
        p.arguments = ["-o", "comm=", "-p", String(pid)]
        let out = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        guard (try? p.run()) != nil else { return nil }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        let comm = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return comm.isEmpty ? nil : (comm as NSString).lastPathComponent
    }

    /// True when this looks like our front end: node is the actual executable, and the
    /// FIRST `.mjs` in the command line is mcp-http.mjs.
    ///
    /// Three earlier attempts each failed differently. A basename substring matched
    /// `tail -f …/mcp-http.mjs` and group-killed it. Requiring the absolute path broke
    /// the documented `node mcp-http.mjs` relative launch, and then deleted the pidfile
    /// on that false negative — destroying the only handle on a live front end. Both
    /// tokenized on spaces, which fails for `mac-developer-bridge (1)`.
    ///
    /// Checking the executable via `ps -o comm=` avoids argv parsing entirely, and
    /// "first .mjs" distinguishes the script node RUNS from one merely passed to it
    /// (`node tests/http.mjs …/mcp-http.mjs`) without needing to tokenize at all.
    static func looksLikeFrontEnd(pid: Int32, commandLine: String) -> Bool {
        guard let exe = executableName(of: pid), exe == "node" || exe.hasPrefix("node") else { return false }
        for flag in [" --check ", " -e ", " --eval ", " -p ", " --print ", " -c "] where commandLine.contains(flag) {
            return false
        }
        guard let firstMjs = commandLine.range(of: ".mjs") else { return false }
        let uptoFirstMjs = commandLine[commandLine.startIndex..<firstMjs.upperBound]
        return uptoFirstMjs.hasSuffix("/mcp-http.mjs") || uptoFirstMjs.hasSuffix(" mcp-http.mjs")
    }

    static func isRunningScript(path expected: String, commandLine: String) -> Bool {
        // Compare against the known absolute path rather than tokenizing on spaces.
        // Splitting on " " silently failed for any install directory containing one —
        // `mac-developer-bridge (1)` from a second download, or anything under
        // "Application Support" — so an orphaned front end there was never reclaimed.
        for flag in [" --check ", " -e ", " --eval ", " -p ", " --print ", " -c "] where commandLine.contains(flag) {
            return false   // inspecting the file, not running it
        }
        // The path must be the argument immediately following the interpreter, so that
        // a command line merely mentioning it (a log tail, `node tests/http.mjs <path>`)
        // does not match.
        guard let idx = commandLine.range(of: expected) else { return false }
        let before = commandLine[commandLine.startIndex..<idx.lowerBound]
        let after = commandLine[idx.upperBound...]
        // Nothing but the executable and dash-flags may precede it.
        let preceding = before.split(separator: " ").map(String.init).filter { !$0.isEmpty }
        guard preceding.count >= 1, preceding.dropFirst().allSatisfy({ $0.hasPrefix("-") }) else { return false }
        return after.isEmpty || after.hasPrefix(" ")
    }

    /// Human-readable cause of a child's exit.
    ///
    /// `terminationStatus` is the SIGNAL number for a signalled child, so reporting
    /// it as "code N" made a SIGTERMed process read as "code 0" — a clean shutdown.
    /// The two exit codes this stack actually produces are also translated, because
    /// "code 74" tells the user nothing.
    static func describeExit(_ process: Process, name: String, isFrontEnd: Bool) -> String {
        if process.terminationReason == .uncaughtSignal {
            return "\(name) killed by signal \(process.terminationStatus)"
        }
        // 74 and 78 are mcp-http.mjs's own exit codes; they say nothing about
        // cloudflared, so they are only translated for the front end. 78 comes solely
        // from its token-file checks — the missing-unlock exit belongs to bridge.mjs,
        // a grandchild the front end respawns rather than dying with.
        if isFrontEnd {
            switch process.terminationStatus {
            case 74: return "front end could not listen — port \(httpPort) already in use"
            case 78: return "front end rejected the token file — see Open Logs"
            default: break
            }
        }
        return "\(name) exited (code \(process.terminationStatus))"
    }

    static func firstTryCloudflareURL(in text: String) -> String? {
        // Matches the quick-tunnel hostname cloudflared announces.
        let pattern = "https://[a-z0-9-]+\\.trycloudflare\\.com"
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: text, range: NSRange(text.startIndex..., in: text)),
              let r = Range(m.range, in: text)
        else { return nil }
        return String(text[r])
    }

    private func appendHandle(_ path: String) -> FileHandle {
        let fm = FileManager.default
        if !fm.fileExists(atPath: path) { fm.createFile(atPath: path, contents: nil) }
        let handle = FileHandle(forWritingAtPath: path) ?? FileHandle.nullDevice
        handle.seekToEndOfFile()
        return handle
    }

    // MARK: Status polling

    private func poll() {
        // Status is measured, not assumed: a child can die without the app
        // noticing, and cloudflared can be up while the front end is not.
        // One child dying must take the whole deployment down. Reporting `.failed`
        // while leaving the sibling running left cloudflared publishing a live public
        // hostname with the unlock file still armed, and the menu saying "not
        // running" — observed. stopBridge() runs first because it resets state.
        if let http = httpProcess, !http.isRunning {
            let why = Self.describeExit(http, name: "front end", isFrontEnd: true)
            stopBridge()
            state = .failed(why)
            render()
            return
        }
        if let tunnel = tunnelProcess, !tunnel.isRunning {
            let why = Self.describeExit(tunnel, name: "cloudflared", isFrontEnd: false)
            stopBridge()
            state = .failed(why)
            render()
            return
        }
        guard httpProcess != nil else { return }

        var request = URLRequest(url: URL(string: "http://127.0.0.1:\(httpPort)/healthz")!)
        request.timeoutInterval = 1.5
        URLSession.shared.dataTask(with: request) { [weak self] _, response, _ in
            guard let self else { return }
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async {
                // Drop a response that outlived the deployment it described. Without
                // this, a health check in flight when the user pressed Stop reassigned
                // .starting afterwards, and poll()'s `guard httpProcess != nil` meant
                // nothing ever corrected it: the menu read "Starting…" permanently
                // while the bridge was stopped and disarmed.
                guard self.httpProcess != nil else { return }
                switch self.state {
                case .failed: break
                default:
                    // Health is about the front end, not about having scraped a
                    // URL. Gating "running" on URL detection left a named
                    // cloudflared tunnel (which never prints a trycloudflare
                    // hostname) stuck in "Starting…" while working correctly.
                    self.state = ok ? .running : .starting
                }
                self.render()
            }
        }.resume()
    }
}

extension Data {
    func append(toFile path: String) throws {
        if let handle = FileHandle(forWritingAtPath: path) {
            handle.seekToEndOfFile()
            handle.write(self)
            try? handle.close()
        } else {
            try write(to: URL(fileURLWithPath: path))
        }
    }
}

func loginShellPATH() -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/bin/zsh")
    p.arguments = ["-lc", "printf %s \"$PATH\""]
    let out = Pipe()
    p.standardOutput = out
    p.standardError = FileHandle.nullDevice   // see loginShellResolve: an unread pipe deadlocks
    do { try p.run() } catch { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    // Last non-empty line only: profile chatter would otherwise be prepended to the
    // PATH handed to both children.
    let value = String(decoding: data, as: UTF8.self)
        .split(separator: "\n")
        .map { $0.trimmingCharacters(in: .whitespaces) }
        .last(where: { !$0.isEmpty }) ?? ""
    // Validate the SHAPE: every colon-separated component must be an absolute path.
    // The previous check (`contains("/") && (!contains(" ") || contains(":"))`) let
    // `warning: /usr/local is out of date` through, because the colon short-circuited
    // the space test — profile chatter would then become the children's PATH.
    // Keep the absolute components and drop the rest. Rejecting the WHOLE value over a
    // single relative entry (a `.` or `node_modules/.bin` in the user's PATH) silently
    // downgraded children to the minimal GUI PATH, losing Homebrew and nvm with no
    // diagnostic while the menu still read "Running".
    let usable = value.split(separator: ":").map(String.init).filter { $0.hasPrefix("/") }
    guard !usable.isEmpty else { return nil }
    return usable.joined(separator: ":")
}

// MARK: - Entry point

let app = NSApplication.shared
let controller = Controller()
app.delegate = controller
app.setActivationPolicy(.accessory)   // menu bar only, no Dock icon
app.run()
