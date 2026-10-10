//! Windows: a GDI copy of the screen. The app's own windows are made with
//! display affinity "exclude from capture" (wm.rs), so the system leaves them
//! out of this copy (Windows 10 version 2004 and later). No permission needed.
//! Coordinates are physical pixels (the app is per-monitor DPI aware).

use std::ffi::c_void;

use image::RgbaImage;
use windows::core::{BOOL, PWSTR};
use windows::Win32::Foundation::{CloseHandle, HWND, LPARAM, RECT};
use windows::Win32::Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED};
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC, SelectObject, BITMAPINFO,
    BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS, SRCCOPY,
};
use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::{EnumWindows, GetWindowRect, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindowVisible};

use super::{Access, CaptureError, Source};
use crate::geometry::Rect;

pub fn capture_display(frame: Rect, _scale: f64) -> Result<RgbaImage, CaptureError> {
    let (x, y) = (frame.x.round() as i32, frame.y.round() as i32);
    let (w, h) = (frame.width.round() as i32, frame.height.round() as i32);
    if w <= 0 || h <= 0 {
        return Err(CaptureError::Failed("That display has no size".into()));
    }
    let fail = |what: &str| CaptureError::Failed(format!("The screenshot failed ({what})"));
    unsafe {
        let screen = GetDC(None);
        let memory = CreateCompatibleDC(Some(screen));
        let bitmap = CreateCompatibleBitmap(screen, w, h);
        let previous = SelectObject(memory, bitmap.into());
        let copied = BitBlt(memory, 0, 0, w, h, Some(screen), x, y, SRCCOPY | CAPTUREBLT);

        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: w,
                biHeight: -h, // top-down rows
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut bgra = vec![0u8; w as usize * h as usize * 4];
        let lines = GetDIBits(memory, bitmap, 0, h as u32, Some(bgra.as_mut_ptr() as *mut c_void), &mut info, DIB_RGB_COLORS);

        SelectObject(memory, previous);
        let _ = DeleteObject(bitmap.into());
        let _ = DeleteDC(memory);
        ReleaseDC(None, screen);

        copied.map_err(|_| fail("BitBlt"))?;
        if lines != h {
            return Err(fail("GetDIBits"));
        }
        for px in bgra.chunks_exact_mut(4) {
            px.swap(0, 2);
            px[3] = 255;
        }
        RgbaImage::from_raw(w as u32, h as u32, bgra).ok_or_else(|| fail("size"))
    }
}

struct Search {
    point: (i32, i32),
    me: u32,
    found: Option<HWND>,
}

unsafe extern "system" fn visit(hwnd: HWND, data: LPARAM) -> BOOL {
    let search = &mut *(data.0 as *mut Search);
    let mut pid = 0u32;
    GetWindowThreadProcessId(hwnd, Some(&mut pid));
    if pid == search.me || !IsWindowVisible(hwnd).as_bool() || IsIconic(hwnd).as_bool() {
        return BOOL(1);
    }
    // Hidden by the system (other virtual desktops, suspended Store apps).
    let mut cloaked = 0u32;
    let _ = DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, &mut cloaked as *mut u32 as *mut c_void, 4);
    if cloaked != 0 {
        return BOOL(1);
    }
    let mut r = RECT::default();
    if GetWindowRect(hwnd, &mut r).is_err() || r.right <= r.left || r.bottom <= r.top {
        return BOOL(1);
    }
    let (x, y) = search.point;
    if x >= r.left && x < r.right && y >= r.top && y < r.bottom {
        search.found = Some(hwnd);
        return BOOL(0); // stop: windows come front to back
    }
    BOOL(1)
}

/// The topmost visible window of another app at `point` (physical pixels).
pub fn window_at(point: (f64, f64)) -> Option<Source> {
    let mut search = Search { point: (point.0.round() as i32, point.1.round() as i32), me: std::process::id(), found: None };
    unsafe {
        let _ = EnumWindows(Some(visit), LPARAM(&mut search as *mut Search as isize));
        let hwnd = search.found?;
        let mut title = [0u16; 512];
        let n = GetWindowTextW(hwnd, &mut title).max(0) as usize;
        let mut pid = 0u32;
        GetWindowThreadProcessId(hwnd, Some(&mut pid));
        Some(Source { app: process_name(pid).unwrap_or_default(), title: String::from_utf16_lossy(&title[..n]) })
    }
}

/// The program's file name without ".exe", e.g. "WINWORD" or "Acrobat".
fn process_name(pid: u32) -> Option<String> {
    unsafe {
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
        let mut path = [0u16; 1024];
        let mut len = path.len() as u32;
        let ok = QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, PWSTR(path.as_mut_ptr()), &mut len).is_ok();
        let _ = CloseHandle(process);
        if !ok {
            return None;
        }
        let full = String::from_utf16_lossy(&path[..len as usize]);
        let file = full.rsplit(['\\', '/']).next().unwrap_or(&full);
        Some(file.strip_suffix(".exe").or_else(|| file.strip_suffix(".EXE")).unwrap_or(file).to_string())
    }
}

pub fn screen_access() -> Access {
    Access::NotNeeded
}

pub fn request_screen_access() -> Access {
    Access::NotNeeded
}
