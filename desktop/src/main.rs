//! Desktop shell: starts the local POSTBote server inside the process (bound to
//! 127.0.0.1, protected by a random token) and shows it in a native window
//! using the operating system's webview — no bundled browser engine.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_menu(menu::build(app.handle())?)?;
            let (url, _server) = tauri::async_runtime::block_on(postbote_server::start_local(0))?;
            tauri::WebviewWindowBuilder::new(app, "main", tauri::WebviewUrl::External(url.parse()?))
                .title("POSTBote")
                .inner_size(1400.0, 900.0)
                .min_inner_size(900.0, 600.0)
                // let the web UI handle drag & drop (moving requests in the sidebar)
                .disable_drag_drop_handler()
                .build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running POSTBote");
}

/// macOS app menu: Tauri's default, except that Cmd+W and Cmd+R go to the web UI
/// (close tab, reload collection); closing the window moves to Cmd+Shift+W.
#[cfg(target_os = "macos")]
mod menu {
    use tauri::menu::{AboutMetadata, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Manager, Runtime};

    const CLOSE_WINDOW: &str = "close-window";

    pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<Menu<R>> {
        app.on_menu_event(|app, event| {
            if event.id() == CLOSE_WINDOW {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            }
        });
        let info = app.package_info();
        let about = AboutMetadata {
            name: Some("POSTBote".into()),
            version: Some(info.version.to_string()),
            ..Default::default()
        };
        let sep = || PredefinedMenuItem::separator(app);
        Menu::with_items(
            app,
            &[
                &Submenu::with_items(
                    app,
                    "POSTBote",
                    true,
                    &[
                        &PredefinedMenuItem::about(app, None, Some(about))?,
                        &sep()?,
                        &PredefinedMenuItem::services(app, None)?,
                        &sep()?,
                        &PredefinedMenuItem::hide(app, None)?,
                        &PredefinedMenuItem::hide_others(app, None)?,
                        &sep()?,
                        &PredefinedMenuItem::quit(app, None)?,
                    ],
                )?,
                &Submenu::with_items(
                    app,
                    "File",
                    true,
                    &[&MenuItem::with_id(app, CLOSE_WINDOW, "Close Window", true, Some("CmdOrCtrl+Shift+W"))?],
                )?,
                // the webview only gets clipboard shortcuts through these items
                &Submenu::with_items(
                    app,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &sep()?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?,
                &Submenu::with_items(app, "View", true, &[&PredefinedMenuItem::fullscreen(app, None)?])?,
                &Submenu::with_items(
                    app,
                    "Window",
                    true,
                    &[&PredefinedMenuItem::minimize(app, None)?, &PredefinedMenuItem::maximize(app, None)?],
                )?,
            ],
        )
    }
}
