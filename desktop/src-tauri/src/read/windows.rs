//! Windows: Windows.Media.Ocr, on device, in the languages of the user's
//! profile. It has a largest image it will read, so a bigger screenshot is
//! scaled down first and the boxes scaled back up.

use image::imageops::{self, FilterType};
use image::RgbaImage;
use windows::Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap};
use windows::Media::Ocr::OcrEngine;
use windows::Storage::Streams::DataWriter;
use windows::Win32::System::WinRT::{RoInitialize, RO_INIT_MULTITHREADED};

use super::{union, Line, Word};
use crate::geometry::Rect;

pub fn recognize(image: &RgbaImage) -> Result<Vec<Line>, String> {
    let fail = |e: windows::core::Error| format!("Reading the screen failed: {}", e.message());
    // This thread may not have WinRT yet; a second call is harmless.
    let _ = unsafe { RoInitialize(RO_INIT_MULTITHREADED) };
    let engine = OcrEngine::TryCreateFromUserProfileLanguages().map_err(fail)?;
    let largest = OcrEngine::MaxImageDimension().unwrap_or(2600).max(1);
    let edge = image.width().max(image.height());
    let (scaled, back) = if edge > largest {
        let k = largest as f64 / edge as f64;
        let (w, h) = (((image.width() as f64 * k).floor() as u32).max(1), ((image.height() as f64 * k).floor() as u32).max(1));
        (imageops::resize(image, w, h, FilterType::Triangle), 1.0 / k)
    } else {
        (image.clone(), 1.0)
    };
    let (w, h) = (scaled.width() as i32, scaled.height() as i32);
    let mut bgra = scaled.into_raw();
    for px in bgra.chunks_exact_mut(4) {
        px.swap(0, 2);
    }
    let writer = DataWriter::new().map_err(fail)?;
    writer.WriteBytes(&bgra).map_err(fail)?;
    let buffer = writer.DetachBuffer().map_err(fail)?;
    let bitmap = SoftwareBitmap::CreateCopyFromBuffer(&buffer, BitmapPixelFormat::Bgra8, w, h).map_err(fail)?;
    let result = engine.RecognizeAsync(&bitmap).map_err(fail)?.get().map_err(fail)?;

    let mut lines = Vec::new();
    for line in result.Lines().map_err(fail)? {
        let mut words = Vec::new();
        for word in line.Words().map_err(fail)? {
            let r = word.BoundingRect().map_err(fail)?;
            let text = word.Text().map_err(fail)?.to_string();
            words.push(Word { text, rect: Rect::new(r.X as f64 * back, r.Y as f64 * back, r.Width as f64 * back, r.Height as f64 * back) });
        }
        let Some(rect) = union(words.iter().map(|w| w.rect)) else { continue };
        // The line's own text: languages written without spaces keep none.
        let text = line.Text().map_err(fail)?.to_string();
        lines.push(Line { text, rect, words, confidence: 1.0 });
    }
    Ok(lines)
}
