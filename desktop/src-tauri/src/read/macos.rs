//! macOS: Vision's text recognition, on device. Each line comes with its
//! words' boxes (boundingBoxForRange), so a selection can start and end
//! inside a line.

use std::ffi::c_void;

use image::RgbaImage;
use objc2::rc::{autoreleasepool, Retained};
use objc2::{msg_send, AnyThread};
use objc2_core_foundation::{CFRetained, CGRect};
use objc2_core_graphics::{kCGColorSpaceSRGB, CGBitmapContextCreate, CGBitmapContextCreateImage, CGColorSpace, CGImage, CGImageAlphaInfo, CGImageByteOrderInfo};
use objc2_foundation::{NSArray, NSDictionary, NSError, NSRange};
use objc2_vision::{VNImageRequestHandler, VNRecognizeTextRequest, VNRecognizedText, VNRectangleObservation, VNRequest, VNRequestTextRecognitionLevel};

use super::{split_words, union, Line, Word};
use crate::geometry::Rect;

pub fn recognize(image: &RgbaImage) -> Result<Vec<Line>, String> {
    autoreleasepool(|_| {
        let (w, h) = (image.width() as f64, image.height() as f64);
        let cg = to_cgimage(image)?;
        let request = VNRecognizeTextRequest::new();
        request.setRecognitionLevel(VNRequestTextRecognitionLevel::Accurate);
        request.setUsesLanguageCorrection(true);
        // Whatever language the page is in, not only English.
        request.setAutomaticallyDetectsLanguage(true);
        let handler = unsafe { VNImageRequestHandler::initWithCGImage_options(VNImageRequestHandler::alloc(), &cg, &NSDictionary::new()) };
        let generic: Retained<VNRequest> = Retained::into_super(Retained::into_super(request.clone()));
        handler.performRequests_error(&NSArray::from_retained_slice(&[generic])).map_err(|e| format!("Reading the screen failed: {}", e.localizedDescription()))?;

        // Vision's boxes are 0 to 1 with the origin at the bottom left.
        let to_px = |b: CGRect| Rect::new(b.origin.x * w, (1.0 - b.origin.y - b.size.height) * h, b.size.width * w, b.size.height * h);
        let mut lines = Vec::new();
        for observation in request.results().map(|r| r.to_vec()).unwrap_or_default() {
            let Some(best) = observation.topCandidates(1).firstObject() else { continue };
            let text = best.string().to_string();
            if text.trim().is_empty() {
                continue;
            }
            let rect = to_px(unsafe { observation.boundingBox() });
            let words = words_of(&best, &text, &to_px).unwrap_or_else(|| split_words(&text, rect));
            let rect = union(words.iter().map(|w| w.rect)).map(|u| if u.width > 0.0 { u } else { rect }).unwrap_or(rect);
            lines.push(Line { text, rect, words, confidence: best.confidence() });
        }
        Ok(lines)
    })
}

/// Each word's own box, from its range in the line's text (UTF-16 offsets).
fn words_of(best: &VNRecognizedText, text: &str, to_px: &impl Fn(CGRect) -> Rect) -> Option<Vec<Word>> {
    let mut words = Vec::new();
    let mut at = 0usize;
    for part in text.split(' ') {
        let len = part.encode_utf16().count();
        if len > 0 {
            let range = NSRange::new(at, len);
            let found: Result<Retained<VNRectangleObservation>, Retained<NSError>> =
                unsafe { msg_send![best, boundingBoxForRange: range, error: _] };
            let rect = to_px(unsafe { found.ok()?.boundingBox() });
            words.push(Word { text: part.to_string(), rect });
        }
        at += len + 1;
    }
    Some(words)
}

/// The screenshot back into a CGImage for Vision.
fn to_cgimage(image: &RgbaImage) -> Result<CFRetained<CGImage>, String> {
    let (width, height) = (image.width() as usize, image.height() as usize);
    let mut pixels = image.as_raw().clone();
    let space = CGColorSpace::with_name(Some(unsafe { kCGColorSpaceSRGB }));
    let info = CGImageAlphaInfo::PremultipliedLast.0 | CGImageByteOrderInfo::Order32Big.0;
    let context = unsafe { CGBitmapContextCreate(pixels.as_mut_ptr() as *mut c_void, width, height, 8, width * 4, space.as_deref(), info) }
        .ok_or("Could not prepare the screenshot to read")?;
    CGBitmapContextCreateImage(Some(&context)).ok_or_else(|| "Could not prepare the screenshot to read".to_string())
}
