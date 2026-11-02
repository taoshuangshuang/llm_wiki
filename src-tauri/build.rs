fn main() {
    // 大型 macOS 调试包可能超出 compact unwind 的编码范围，导致可捕获的 panic 直接 abort。
    // 使用经典链接器生成有效展开表，确保解析器与命令边界的 catch_unwind 仍能保护应用。
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos")
        && std::process::Command::new("xcrun").args(["--find", "ld-classic"]).output()
            .is_ok_and(|output| output.status.success())
    {
        println!("cargo:rustc-link-arg=-Wl,-ld_classic");
    }
    let windows = tauri_build::WindowsAttributes::new()
        .app_manifest(include_str!("windows-app-manifest.xml"));
    let attrs = tauri_build::Attributes::new().windows_attributes(windows);
    tauri_build::try_build(attrs).expect("failed to run tauri build script");
}
