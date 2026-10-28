//! Desktop shell: starts the local POSTBote server inside the process (bound to
//! 127.0.0.1, protected by a random token) and shows it in a native window
//! using the operating system's webview — no bundled browser engine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let (url, _server) = tauri::async_runtime::block_on(postbote_server::start_local(0))?;
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url.parse()?))
                .title("POSTBote")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running POSTBote");
}
