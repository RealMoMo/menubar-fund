// 状态栏基金 - Tauri 主进程
// 职责:Tray 状态栏图标、左键点击 toggle 悬浮窗并定位、右键菜单(退出)、运行时改标题

use tauri::{
    Manager,
    menu::{Menu, MenuItem},
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

/// 前端调用:切换状态栏图标为触发态(红点)/正常态
/// spec §5.5 辅助提示
#[tauri::command]
fn set_tray_alert(app: tauri::AppHandle, active: bool) {
    if let Some(tray) = app.tray_by_id("main-tray") {
        if active {
            // 触发态:用带红点的图标(编译期嵌入,避免运行期路径问题)
            if let Ok(icon) = tauri::image::Image::from_bytes(include_bytes!(
                "../icons/icon-alert.png"
            )) {
                let _ = tray.set_icon(Some(icon));
                let _ = tray.set_icon_as_template(false); // 彩色图标不用 template
            }
        } else {
            // 恢复默认图标 + template 模式
            let _ = tray.set_icon(app.default_window_icon().cloned());
            let _ = tray.set_icon_as_template(true);
        }
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
        .plugin(tauri_plugin_notification::init())
        .invoke_handler(tauri::generate_handler![set_tray_title, set_tray_alert])
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // 右键菜单(基础项:退出)。左键单击仍走 toggle 悬浮窗。
            let quit_item = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&quit_item])?;

            // 创建状态栏图标
            let _tray = TrayIconBuilder::with_id("main-tray")
                .tooltip("状态栏基金")
                .icon(app.default_window_icon().cloned().unwrap())
                .icon_as_template(true)
                .title("¥--")
                .show_menu_on_left_click(false)
                .menu(&menu)
                .on_menu_event(|app, event| {
                    // 右键菜单点击
                    if event.id().as_ref() == "quit" {
                        app.exit(0);
                    }
                })
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
