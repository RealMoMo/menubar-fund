// 状态栏基金 - Tauri 主进程
// 职责:Tray 状态栏图标、左键点击 toggle 悬浮窗并定位、运行时改标题

use tauri::{
    Manager,
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    LogicalPosition,
};

/// 前端调用:设置状态栏标题(净值 + 涨跌)
#[tauri::command]
fn set_tray_title(app: tauri::AppHandle, title: String) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        let _ = tray.set_title(Some(&title));
    }
}

/// 把悬浮窗定位到状态栏图标正下方
/// position 是 tray 事件的物理坐标(图标点击位置)
fn place_window(window: &tauri::WebviewWindow, position: (f64, f64)) {
    let (px, py) = position;
    let win_size = window.outer_size().ok();
    let (w, h) = win_size
        .map(|s| (s.width as f64, s.height as f64))
        .unwrap_or((360.0, 480.0));

    if let Ok(Some(monitor)) = window.monitor_from_point(px, py) {
        let scale = monitor.scale_factor();
        let pos = monitor.position();
        let size = monitor.size();

        // 物理坐标 → 相对当前显示器的逻辑坐标
        let logical_x = (px - pos.x as f64) / scale;
        // 状态栏在屏幕顶部,窗口放在图标下方
        let mut x = logical_x - w / 2.0;
        let mut y = 6.0;

        let screen_w = size.width as f64 / scale;
        let screen_h = size.height as f64 / scale;
        if x + w > screen_w - 4.0 {
            x = screen_w - w - 4.0;
        }
        if x < 4.0 {
            x = 4.0;
        }
        if y + h > screen_h - 4.0 {
            y = screen_h - h - 4.0;
        }

        let _ = window.set_position(LogicalPosition::new(
            pos.x as f64 / scale + x,
            pos.y as f64 / scale + y,
        ));
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .invoke_handler(tauri::generate_handler![set_tray_title])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 创建状态栏图标
            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("状态栏基金")
                .icon(app.default_window_icon().cloned().unwrap())
                .icon_as_template(true)
                .title("¥--")
                .show_menu_on_left_click(false)
                .on_tray_icon_event(|tray, event| {
                    // 只响应左键单击抬起
                    let app = tray.app_handle();
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        position,
                        ..
                    } = event
                    {
                        if let Some(window) = app.get_webview_window("main") {
                            if window.is_visible().unwrap_or(false) {
                                let _ = window.hide();
                            } else {
                                place_window(&window, (position.x, position.y));
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    }
                })
                .build(app)?;

            // 失焦自动隐藏(类 menubar 体验)。截图模式(MF_SCREENSHOT)下居中显示且不隐藏
            if let Some(window) = app.get_webview_window("main") {
                if std::env::var("MF_SCREENSHOT").as_deref() == Ok("1") {
                    use tauri::Manager;
                    let _ = window.show();
                    let _ = window.center();
                    let _ = window.set_focus();
                } else {
                    let win_clone = window.clone();
                    window.on_window_event(move |event| {
                        if let tauri::WindowEvent::Focused(false) = event {
                            let _ = win_clone.hide();
                        }
                    });
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
