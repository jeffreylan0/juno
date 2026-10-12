//! macOS: ScreenCaptureKit's one-shot screenshot (macOS 14+), with every
//! window of this app filtered out, and the window list for the source.
//!
//! Both ScreenCaptureKit calls answer through completion handlers on a queue
//! of the system's; the calling thread (never the main thread: the commands
//! in lib.rs run on a worker thread) waits for them with a timeout.

use std::ffi::c_void;
use std::ptr::NonNull;
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use image::RgbaImage;
use objc2::rc::Retained;
use objc2::AnyThread;
use objc2_core_foundation::{CFArray, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect, CGSize};
use objc2_core_graphics::{
    kCGColorSpaceSRGB, kCGNullWindowID, kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowOwnerName, kCGWindowOwnerPID,
    CGBitmapContextCreate, CGColorSpace, CGContext, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo, CGPreflightScreenCaptureAccess,
    CGRectMakeWithDictionaryRepresentation, CGRequestScreenCaptureAccess, CGWindowListCopyWindowInfo, CGWindowListOption,
};
use objc2_foundation::{NSArray, NSError};
use objc2_screen_capture_kit::{SCContentFilter, SCDisplay, SCScreenshotManager, SCShareableContent, SCStreamConfiguration};

use super::{Access, CaptureError, Source};
use crate::geometry::Rect;

const WAIT: Duration = Duration::from_secs(6);
/// SCStreamErrorUserDeclined: Screen Recording is off for this app.
const USER_DECLINED: isize = -3801;

/// ScreenCaptureKit's objects are immutable snapshots, safe to hand between threads.
struct Sendable<T>(T);
unsafe impl<T> Send for Sendable<T> {}

pub fn screen_access() -> Access {
    if CGPreflightScreenCaptureAccess() {
        Access::Granted
    } else {
        Access::Denied
    }
}

pub fn request_screen_access() -> Access {
    if CGRequestScreenCaptureAccess() {
        Access::Granted
    } else {
        Access::Denied
    }
}

fn error_of(error: *mut NSError, what: &str) -> CaptureError {
    match unsafe { error.as_ref() } {
        Some(e) if e.code() == USER_DECLINED => CaptureError::Permission,
        Some(e) => CaptureError::Failed(format!("{what}: {}", e.localizedDescription())),
        None => CaptureError::Failed(format!("{what}: no result")),
    }
}

fn shareable_content() -> Result<Retained<SCShareableContent>, CaptureError> {
    let (tx, rx) = mpsc::channel::<Sendable<Result<Retained<SCShareableContent>, CaptureError>>>();
    let block = RcBlock::new(move |content: *mut SCShareableContent, error: *mut NSError| {
        let result = match unsafe { Retained::retain(content) } {
            Some(content) => Ok(content),
            None => Err(error_of(error, "Listing the displays failed")),
        };
        let _ = tx.send(Sendable(result));
    });
    unsafe { SCShareableContent::getShareableContentExcludingDesktopWindows_onScreenWindowsOnly_completionHandler(true, true, &block) };
    rx.recv_timeout(WAIT).map_err(|_| CaptureError::Failed("Listing the displays timed out".into()))?.0
}

fn screenshot(filter: &SCContentFilter, config: &SCStreamConfiguration) -> Result<CFRetained<CGImage>, CaptureError> {
    let (tx, rx) = mpsc::channel::<Sendable<Result<CFRetained<CGImage>, CaptureError>>>();
    let block = RcBlock::new(move |image: *mut CGImage, error: *mut NSError| {
        let result = match NonNull::new(image) {
            Some(image) => Ok(unsafe { CFRetained::retain(image) }),
            None => Err(error_of(error, "The screenshot failed")),
        };
        let _ = tx.send(Sendable(result));
    });
    unsafe { SCScreenshotManager::captureImageWithFilter_configuration_completionHandler(filter, config, Some(&block)) };
    rx.recv_timeout(WAIT).map_err(|_| CaptureError::Failed("The screenshot timed out".into()))?.0
}

fn same_frame(a: CGRect, b: Rect) -> bool {
    (a.origin.x - b.x).abs() < 1.0 && (a.origin.y - b.y).abs() < 1.0 && (a.size.width - b.width).abs() < 1.0 && (a.size.height - b.height).abs() < 1.0
}

/// `frame` is the display's frame in points (global, origin top-left of the main display).
pub fn capture_display(frame: Rect, scale: f64) -> Result<RgbaImage, CaptureError> {
    if !CGPreflightScreenCaptureAccess() {
        return Err(CaptureError::Permission);
    }
    let content = shareable_content()?;
    let displays = unsafe { content.displays() };
    let display: Retained<SCDisplay> = displays
        .iter()
        .find(|d| same_frame(unsafe { d.frame() }, frame))
        .ok_or_else(|| CaptureError::Failed("That display is no longer connected".into()))?;

    // Every window of ours stays out of the picture: the bar, the panel, settings.
    let me = std::process::id() as i32;
    let ours: Vec<_> = unsafe { content.applications() }.iter().filter(|a| unsafe { a.processID() } == me).collect();
    let ours = NSArray::from_retained_slice(&ours);
    let filter = unsafe {
        SCContentFilter::initWithDisplay_excludingApplications_exceptingWindows(SCContentFilter::alloc(), &display, &ours, &NSArray::new())
    };

    let config = unsafe { SCStreamConfiguration::new() };
    let pixel_scale = match unsafe { filter.pointPixelScale() } as f64 {
        s if s > 0.0 => s,
        _ => scale,
    };
    let content_rect = unsafe { filter.contentRect() };
    let width = (content_rect.size.width * pixel_scale).round().max(1.0) as usize;
    let height = (content_rect.size.height * pixel_scale).round().max(1.0) as usize;
    unsafe {
        config.setWidth(width);
        config.setHeight(height);
        config.setShowsCursor(false);
    }
    let image = screenshot(&filter, &config)?;
    to_rgba(&image)
}

/// Draws the screenshot into an sRGB RGBA bitmap (whatever format it came in).
fn to_rgba(image: &CGImage) -> Result<RgbaImage, CaptureError> {
    let width = CGImage::width(Some(image));
    let height = CGImage::height(Some(image));
    let mut pixels = vec![0u8; width * height * 4];
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }));
    let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    let context = unsafe { CGBitmapContextCreate(pixels.as_mut_ptr() as *mut c_void, width, height, 8, width * 4, space.as_deref(), info) }
        .ok_or_else(|| CaptureError::Failed("Could not read the screenshot".into()))?;
    let all = CGRect::new(CGPoint::new(0.0, 0.0), CGSize::new(width as f64, height as f64));
    CGContext::draw_image(Some(&context), all, Some(image));
    drop(context);
    RgbaImage::from_raw(width as u32, height as u32, pixels).ok_or_else(|| CaptureError::Failed("The screenshot has the wrong size".into()))
}

/// The frontmost normal window of another app under `point` (points).
pub fn window_at(point: (f64, f64)) -> Option<Source> {
    window_list().into_iter().find(|(_, r)| r.contains(point.0, point.1)).map(|(s, _)| s)
}

/// Other apps' normal windows on screen, front to back, with their frames
/// (points), from the window list. Titles need Screen Recording permission,
/// which a capture already has.
fn window_list() -> Vec<(Source, Rect)> {
    let Some(list) = CGWindowListCopyWindowInfo(CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements, kCGNullWindowID) else {
        return Vec::new();
    };
    let list: CFRetained<CFArray> = list;
    let me = std::process::id() as i64;
    let mut out = Vec::new();
    for i in 0..list.count() {
        let dict = unsafe { list.value_at_index(i) } as *const CFDictionary;
        let Some(dict) = (unsafe { dict.as_ref() }) else { continue };
        let number = |key: &CFString| -> Option<i64> { value(dict, key)?.downcast_ref::<CFNumber>()?.as_i64() };
        let text = |key: &CFString| -> String {
            value(dict, key).and_then(|v| v.downcast_ref::<CFString>().map(|s| s.to_string())).unwrap_or_default()
        };
        if number(unsafe { kCGWindowOwnerPID }) == Some(me) || number(unsafe { kCGWindowLayer }) != Some(0) {
            continue;
        }
        let Some(bounds) = value(dict, unsafe { kCGWindowBounds }).and_then(|v| v.downcast_ref::<CFDictionary>()) else { continue };
        let mut rect = CGRect::default();
        if !unsafe { CGRectMakeWithDictionaryRepresentation(Some(bounds), &mut rect) } {
            continue;
        }
        let r = Rect::new(rect.origin.x, rect.origin.y, rect.size.width, rect.size.height);
        out.push((Source { app: text(unsafe { kCGWindowOwnerName }), title: text(unsafe { kCGWindowName }) }, r));
    }
    out
}

fn value<'a>(dict: &'a CFDictionary, key: &CFString) -> Option<&'a CFType> {
    let v = unsafe { dict.value(key as *const CFString as *const c_void) } as *const CFType;
    unsafe { v.as_ref() }
}
