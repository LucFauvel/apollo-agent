//! Links the Go tsnet node, built by ../build.sh (or build.ps1) as a static C archive in
//! `APOLLO_TAILNET_LIB_DIR`, plus what the Go runtime and Tailscale need from the OS.
fn main() {
    // macOS: let Node's symbols resolve at load time. Windows needs nothing here: napi-rs
    // looks Node's functions up in the running app (its default "dyn-symbols"), so the
    // helper's demand for a libnode.dll to link against does not apply.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("windows") {
        napi_build::setup();
    }
    let dir = std::env::var("APOLLO_TAILNET_LIB_DIR").expect("APOLLO_TAILNET_LIB_DIR: the folder with libapollotailnet.a");
    println!("cargo:rerun-if-env-changed=APOLLO_TAILNET_LIB_DIR");
    println!("cargo:rerun-if-changed={dir}/libapollotailnet.a");
    println!("cargo:rustc-link-search=native={dir}");
    println!("cargo:rustc-link-lib=static=apollotailnet");
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => {
            for framework in ["CoreFoundation", "Security", "SystemConfiguration", "IOKit"] {
                println!("cargo:rustc-link-lib=framework={framework}");
            }
            println!("cargo:rustc-link-lib=resolv");
        }
        Ok("windows") => {
            for lib in ["ws2_32", "winmm", "ntdll", "iphlpapi", "userenv", "crypt32", "bcrypt", "advapi32", "ole32", "oleaut32", "dnsapi", "secur32", "wintrust"] {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
        _ => {}
    }
}
