use std::io::{Read, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::time::Duration;

use tauri::Manager;

/// 用户提供的 DeepSeek API Key（构建时打入二进制；本地单机 .app 分发）
const DS_KEY: &str = "sk-0e97dc151b75440f8e08e5defb555b28";

/// 极简 HTTP 探测：core 用 /health 精确验证；proxy 只要响应任意 HTTP 即算存活
fn http_alive(port: u16, path: &str) -> bool {
    let addr = format!("127.0.0.1:{port}");
    let Ok(a) = addr.parse() else { return false };
    let Ok(mut s) = TcpStream::connect_timeout(&a, Duration::from_millis(800)) else { return false };
    s.set_read_timeout(Some(Duration::from_millis(3000))).ok();
    let req = format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n");
    if s.write_all(req.as_bytes()).is_err() { return false; }
    let mut buf = [0u8; 128];
    if s.read(&mut buf).is_err() { return false; }
    let head = String::from_utf8_lossy(&buf);
    if path == "/health" {
        head.starts_with("HTTP/1.1 200")
    } else {
        head.starts_with("HTTP/1.1 ")
    }
}

fn core_healthy() -> bool { http_alive(8420, "/health") }
fn proxy_healthy() -> bool { http_alive(8096, "/") }
fn tools_healthy() -> bool { http_alive(8450, "/health") }
fn godot_healthy() -> bool { http_alive(8455, "/health") }
fn director_healthy() -> bool { http_alive(8456, "/health") }

/// 容错探测：服务在忙（蒸馏/LLM 任务）时单次探测可能超时，多次重试避免误杀健康服务
fn probe_healthy(healthy: fn() -> bool, tries: u32) -> bool {
    for _ in 0..tries {
        if healthy() { return true; }
        std::thread::sleep(Duration::from_millis(800));
    }
    healthy()
}

/// 以孤儿进程方式拉起服务（App 退出后仍常驻）
fn spawn_service(node: &str, cwd: &str, args: &[&str], envs: &[(&str, &str)]) {
    let mut cmd = Command::new(node);
    cmd.args(args).current_dir(cwd).envs(envs.iter().copied());
    #[cfg(target_os = "macos")]
    { cmd.stdout(Stdio::null()).stderr(Stdio::null()); }
    if let Ok(child) = cmd.spawn() { drop(child); }
}

fn xml_escape(s: &str) -> String { s.replace('&', "&amp;").replace('<', "&lt;") }

fn plist(label: &str, node: &str, cwd: &str, args: &[&str], extra_env: &str) -> String {
    // ProgramArguments[0] 必须是可执行文件本身（node），否则 launchd 直接 EX_CONFIG(78)
    let mut args_xml = format!("    <string>{}</string>\n", xml_escape(node));
    for a in args {
        args_xml.push_str(&format!("    <string>{}</string>\n", xml_escape(a)));
    }
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>{label}</string>
  <key>ProgramArguments</key><array>
{args_xml}  </array>
  <key>WorkingDirectory</key><string>{cwd}</string>
  <key>EnvironmentVariables</key><dict>
    <key>TDAI_LLM_API_KEY</key><string>{key}</string>
{extra_env}  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>{log_out}</string>
  <key>StandardErrorPath</key><string>{log_err}</string>
</dict></plist>
"#,
        label = xml_escape(label),
        cwd = xml_escape(cwd),
        log_out = format!("/tmp/harness-{}.out.log", label.trim_start_matches("dev.harness.")),
        log_err = format!("/tmp/harness-{}.err.log", label.trim_start_matches("dev.harness.")),
        key = DS_KEY,
    )
}

/// 确保 launchd 常驻服务在跑。已健康则不动（快启动、不打断运行中的服务）；
/// 不健康才修复：bootout → 等旧实例完全卸载 → bootstrap（带重试），
/// 避免「旧进程退出未完成导致 bootstrap 失败」的竞态（症状：服务被误杀后
/// 标签消失、只能靠孤儿进程兜底）。
fn ensure_launchd_service(label: &str, plist_path: &PathBuf, healthy: fn() -> bool) -> bool {
    if probe_healthy(healthy, 3) { return true; }
    let uid = unsafe { libc::getuid() };
    let domain = format!("gui/{}/{}", uid, label);
    let _ = Command::new("launchctl").args(["bootout", &domain]).output();
    for _ in 0..10 {
        let still = Command::new("launchctl")
            .args(["print", &domain])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !still { break; }
        std::thread::sleep(Duration::from_millis(500));
    }
    let mut ok = false;
    for _ in 0..4 {
        ok = Command::new("launchctl")
            .args(["bootstrap", &format!("gui/{}", uid), plist_path.to_str().unwrap_or("")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if ok { break; }
        std::thread::sleep(Duration::from_millis(1500));
    }
    if ok {
        let _ = Command::new("launchctl").args(["enable", &domain]).output();
    }
    ok
}

fn wait_until(cond: fn() -> bool, timeout_secs: u64) -> bool {
    let start = std::time::Instant::now();
    while start.elapsed().as_secs() < timeout_secs {
        if cond() { return true; }
        std::thread::sleep(Duration::from_millis(500));
    }
    cond()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let res = app.path().resource_dir()?;
            let support = app.path().app_data_dir()?;
            let logs = support.join("logs");
            std::fs::create_dir_all(&logs).ok();
            let home = std::env::var("HOME").unwrap_or_default();

            // 配置模板 → 用户目录实际配置（含 Key 与可写路径）
            let gw_tpl = std::fs::read_to_string(res.join("resources/config/tdai-gateway.tpl.yaml")).unwrap_or_default();
            let px_tpl = std::fs::read_to_string(res.join("resources/config/proxy-config.tpl.yaml")).unwrap_or_default();
            let gw = gw_tpl.replace("__HOME__", &home).replace("__DS_KEY__", DS_KEY);
            let px = px_tpl.replace("__HOME__", &home).replace("__DS_KEY__", DS_KEY);
            std::fs::write(support.join("tdai-gateway.yaml"), gw).ok();
            std::fs::write(support.join("proxy-config.yaml"), px).ok();

            let node = res.join("resources/node/bin/node");
            let core_dir = res.join("resources/memory-core");
            let proxy_dir = res.join("resources/memory-proxy");
            let tools_dir = res.join("resources/tools-server");
            let gw_cfg = support.join("tdai-gateway.yaml").to_string_lossy().to_string();
            let px_cfg = support.join("proxy-config.yaml").to_string_lossy().to_string();
            let node_s = node.to_string_lossy().to_string();
            let core_s = core_dir.to_string_lossy().to_string();
            let proxy_s = proxy_dir.to_string_lossy().to_string();
            let tools_s = tools_dir.to_string_lossy().to_string();

            // 1) 写 launchd plist（指向 App 内资源，App 是服务的所有者）
            let agents_dir = PathBuf::from(format!("{}/Library/LaunchAgents", home));
            std::fs::create_dir_all(&agents_dir).ok();
            let core_plist = agents_dir.join("dev.harness.memory-core.plist");
            let proxy_plist = agents_dir.join("dev.harness.memory-proxy.plist");
            let tools_plist = agents_dir.join("dev.harness.tools.plist");
            let godot_plist = agents_dir.join("dev.harness.godot.plist");
            std::fs::write(
                &core_plist,
                plist("dev.harness.memory-core", &node_s, &core_s,
                    &["--import", "tsx", "src/gateway/server.ts"],
                    &format!("    <key>TDAI_GATEWAY_CONFIG</key><string>{}</string>\n    <key>TDAI_GATEWAY_HOST</key><string>127.0.0.1</string>\n    <key>TDAI_GATEWAY_PORT</key><string>8420</string>\n", xml_escape(&gw_cfg))),
            ).ok();
            std::fs::write(
                &proxy_plist,
                plist("dev.harness.memory-proxy", &node_s, &proxy_s,
                    &["--import", "tsx/esm", "src/index.ts", "--config", &px_cfg],
                    ""),
            ).ok();
            std::fs::write(
                &tools_plist,
                plist("dev.harness.tools", &node_s, &tools_s,
                    &["index.mjs"],
                    &format!("    <key>DSH_TOOLS_WORKSPACE</key><string>{}</string>\n    <key>DSH_TOOLS_PORT</key><string>8450</string>\n", xml_escape(&format!("{}/Harness", home)))),
            ).ok();
            std::fs::write(
                &godot_plist,
                plist("dev.harness.godot", &node_s, &tools_s,
                    &["godot-server.mjs"],
                    &format!("    <key>DSH_TOOLS_WORKSPACE</key><string>{}</string>\n    <key>DSH_GODOT_PORT</key><string>8455</string>\n", xml_escape(&format!("{}/Harness", home)))),
            ).ok();
            let director_plist = agents_dir.join("dev.harness.director.plist");
            std::fs::write(
                &director_plist,
                plist("dev.harness.director", &node_s, &tools_s,
                    &["director-server.mjs"],
                    &format!("    <key>DSH_TOOLS_WORKSPACE</key><string>{}</string>\n    <key>DSH_DIRECTOR_PORT</key><string>8456</string>\n", xml_escape(&format!("{}/Harness", home)))),
            ).ok();

            // 2) 确保 launchd 服务在跑（健康则不动；不健康才修复，见 ensure_launchd_service）
            ensure_launchd_service("dev.harness.memory-core", &core_plist, core_healthy);
            ensure_launchd_service("dev.harness.memory-proxy", &proxy_plist, proxy_healthy);
            ensure_launchd_service("dev.harness.tools", &tools_plist, tools_healthy);
            ensure_launchd_service("dev.harness.godot", &godot_plist, godot_healthy);
            ensure_launchd_service("dev.harness.director", &director_plist, director_healthy);

            // 3) 等健康；launchd 修复失败/不可用时回退到进程内自举（孤儿进程常驻）
            if !wait_until(core_healthy, 25) {
                spawn_service(&node_s, &core_s,
                    &["--import", "tsx", "src/gateway/server.ts"],
                    &[("TDAI_GATEWAY_CONFIG", gw_cfg.as_str()), ("TDAI_GATEWAY_HOST", "127.0.0.1"),
                      ("TDAI_GATEWAY_PORT", "8420"), ("TDAI_LLM_API_KEY", DS_KEY)]);
                wait_until(core_healthy, 25);
            }
            if !wait_until(proxy_healthy, 25) {
                spawn_service(&node_s, &proxy_s,
                    &["--import", "tsx/esm", "src/index.ts", "--config", px_cfg.as_str()], &[]);
                wait_until(proxy_healthy, 25);
            }
            let tools_workspace = format!("{}/Harness", home);
            let tools_workspace_s = tools_workspace.as_str();
            if !wait_until(godot_healthy, 15) {
                spawn_service(&node_s, &tools_s,
                    &["godot-server.mjs"],
                    &[("DSH_TOOLS_WORKSPACE", tools_workspace_s), ("DSH_GODOT_PORT", "8455")]);
                wait_until(godot_healthy, 15);
            }
            if !wait_until(director_healthy, 15) {
                spawn_service(&node_s, &tools_s,
                    &["director-server.mjs"],
                    &[("DSH_TOOLS_WORKSPACE", tools_workspace_s), ("DSH_DIRECTOR_PORT", "8456")]);
                wait_until(director_healthy, 15);
            }
            if !wait_until(tools_healthy, 15) {
                spawn_service(&node_s, &tools_s,
                    &["index.mjs"],
                    &[("DSH_TOOLS_WORKSPACE", tools_workspace_s), ("DSH_TOOLS_PORT", "8450")]);
                wait_until(tools_healthy, 15);
            }

            println!("[harness] services ready: core={} proxy={} tools={}", core_healthy(), proxy_healthy(), tools_healthy());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}