// The web UI (web/dist) is embedded into the binary. Make sure the folder
// exists so a fresh checkout compiles before `npm run build`; the server then
// answers with a hint instead of the UI.
fn main() {
    let dist = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../web/dist");
    let _ = std::fs::create_dir_all(&dist);
    println!("cargo:rerun-if-changed=build.rs");
}
