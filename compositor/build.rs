fn main() {
    println!("cargo::rerun-if-env-changed=CEF_PATH");

    if let Ok(dir) = std::env::var("DEP_CEF_DLL_WRAPPER_CEF_DIR") {
        if !dir.is_empty() {
            println!("cargo::rustc-link-arg=-Wl,-rpath,{}", dir);
            println!("cargo::rustc-link-arg=-Wl,-rpath-link,{}", dir);
        }
    }

    println!("cargo::rerun-if-changed=build.rs");
}
