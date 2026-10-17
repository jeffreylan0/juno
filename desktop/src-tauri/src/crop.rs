//! Cropping a captured display down to the selection: the CSS-pixel rectangle
//! is scaled to device pixels, clamped to the image, downscaled to at most
//! 1568 px on the long edge (what the models read without resampling it
//! themselves), and for a freeform shape everything outside the outline is
//! painted white (white rather than transparent, since some models read
//! transparency as black). The outline fills by the non-zero winding rule,
//! tested at pixel centres, as a canvas would fill it.
//!
//! The scale is taken from the image itself (its width over the overlay's
//! CSS width), so a capture that came back at another resolution still lines
//! up with what was drawn.

use base64::Engine;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::{self, FilterType};
use image::{ImageEncoder, RgbImage, RgbaImage};
use serde::Deserialize;

/// Longest edge sent to a model; larger crops are downscaled.
pub const MAX_EDGE: u32 = 1568;

/// What to cut out, in the overlay's CSS pixels.
#[derive(Clone, Debug, Deserialize)]
pub struct CropRequest {
    pub rect: CssRect,
    /// Freeform outline, CSS pixels. Fewer than three points means a plain box.
    #[serde(default)]
    pub path: Option<Vec<CssPoint>>,
    /// The overlay's size in CSS pixels (innerWidth × innerHeight).
    pub viewport: CssSize,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct CssRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct CssPoint {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
pub struct CssSize {
    pub width: f64,
    pub height: f64,
}

/// A rectangle of whole device pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixelRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, PartialEq, Eq)]
pub enum CropError {
    /// Nothing left after clamping to the display.
    Empty,
    /// A freeform outline with more points than anyone draws.
    TooDetailed,
}

/// Points in a freeform outline: a long, slow drag makes a few thousand.
pub const MAX_PATH_POINTS: usize = 20_000;

impl std::fmt::Display for CropError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CropError::Empty => write!(f, "Selection is empty after clamping to the screen"),
            CropError::TooDetailed => write!(f, "That outline has too many points"),
        }
    }
}

/// The CSS rect in device pixels (outwards to whole pixels), clamped to the image.
pub fn device_rect(rect: CssRect, sx: f64, sy: f64, image: (u32, u32)) -> PixelRect {
    let x0 = (rect.x * sx).floor().max(0.0) as u32;
    let y0 = (rect.y * sy).floor().max(0.0) as u32;
    let x1 = ((rect.x + rect.width) * sx).ceil().min(image.0 as f64).max(0.0) as u32;
    let y1 = ((rect.y + rect.height) * sy).ceil().min(image.1 as f64).max(0.0) as u32;
    PixelRect { x: x0.min(x1), y: y0.min(y1), width: x1.saturating_sub(x0), height: y1.saturating_sub(y0) }
}

/// Scales (width, height) down so the long edge is at most `max_edge`.
pub fn fit_within(width: u32, height: u32, max_edge: u32) -> (u32, u32) {
    let longest = width.max(height);
    if longest <= max_edge {
        return (width, height);
    }
    let s = max_edge as f64 / longest as f64;
    (((width as f64 * s).round() as u32).max(1), ((height as f64 * s).round() as u32).max(1))
}

/// Maps the outline from CSS pixels into the output image: to device pixels,
/// to the crop's origin, then to the (possibly smaller) output.
pub fn path_to_crop(path: &[CssPoint], sx: f64, sy: f64, src: PixelRect, out: (u32, u32)) -> Vec<(f64, f64)> {
    let kx = out.0 as f64 / src.width as f64;
    let ky = out.1 as f64 / src.height as f64;
    path.iter().map(|p| ((p.x * sx - src.x as f64) * kx, (p.y * sy - src.y as f64) * ky)).collect()
}

/// Crops `image` (a whole display, device pixels) to the request.
pub fn crop(image: &RgbaImage, req: &CropRequest) -> Result<RgbImage, CropError> {
    if req.path.as_ref().is_some_and(|p| p.len() > MAX_PATH_POINTS) {
        return Err(CropError::TooDetailed);
    }
    let (w, h) = image.dimensions();
    let sx = if req.viewport.width > 0.0 { w as f64 / req.viewport.width } else { 1.0 };
    let sy = if req.viewport.height > 0.0 { h as f64 / req.viewport.height } else { 1.0 };
    let src = device_rect(req.rect, sx, sy, (w, h));
    if src.width == 0 || src.height == 0 {
        return Err(CropError::Empty);
    }
    let piece = imageops::crop_imm(image, src.x, src.y, src.width, src.height).to_image();
    let out = fit_within(src.width, src.height, MAX_EDGE);
    let piece = if out == (src.width, src.height) { piece } else { imageops::resize(&piece, out.0, out.1, FilterType::CatmullRom) };
    // Screens are opaque; whatever alpha the capture carried is dropped.
    let mut rgb = RgbImage::from_fn(out.0, out.1, |x, y| {
        let p = piece.get_pixel(x, y).0;
        image::Rgb([p[0], p[1], p[2]])
    });
    if let Some(path) = req.path.as_deref().filter(|p| p.len() >= 3) {
        paint_outside(&mut rgb, &path_to_crop(path, sx, sy, src, out));
    }
    Ok(rgb)
}

/// Paints white every pixel whose centre lies outside the polygon (non-zero winding).
pub fn paint_outside(image: &mut RgbImage, polygon: &[(f64, f64)]) {
    let (w, h) = image.dimensions();
    let n = polygon.len();
    let mut crossings: Vec<(f64, i32)> = Vec::with_capacity(n);
    for row in 0..h {
        let yc = row as f64 + 0.5;
        crossings.clear();
        for i in 0..n {
            let (x0, y0) = polygon[i];
            let (x1, y1) = polygon[(i + 1) % n];
            // Half-open, so a vertex exactly on the scanline counts once.
            if (y0 <= yc && yc < y1) || (y1 <= yc && yc < y0) {
                let x = x0 + (yc - y0) * (x1 - x0) / (y1 - y0);
                crossings.push((x, if y1 > y0 { 1 } else { -1 }));
            }
        }
        crossings.sort_by(|a, b| a.0.total_cmp(&b.0));
        let mut next = 0;
        let mut winding = 0;
        for col in 0..w {
            let xc = col as f64 + 0.5;
            while next < crossings.len() && crossings[next].0 <= xc {
                winding += crossings[next].1;
                next += 1;
            }
            if winding == 0 {
                image.put_pixel(col, row, image::Rgb([255, 255, 255]));
            }
        }
    }
}

/// PNG bytes, compressed for speed (a crop is sent once and kept once).
pub fn encode_png(image: &RgbImage) -> Vec<u8> {
    let mut out = Vec::new();
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, PngFilter::Adaptive)
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgb8)
        .expect("encoding a PNG into memory cannot fail");
    out
}

pub fn png_data_url(image: &RgbImage) -> String {
    format!("data:image/png;base64,{}", base64::engine::general_purpose::STANDARD.encode(encode_png(image)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    const RED: Rgba<u8> = Rgba([220, 20, 20, 255]);
    const BLUE: Rgba<u8> = Rgba([20, 20, 220, 255]);

    fn rect(x: f64, y: f64, width: f64, height: f64) -> CssRect {
        CssRect { x, y, width, height }
    }

    fn pt(x: f64, y: f64) -> CssPoint {
        CssPoint { x, y }
    }

    #[test]
    fn device_rect_rounds_outwards_and_clamps() {
        assert_eq!(device_rect(rect(10.2, 20.7, 100.0, 50.0), 2.0, 2.0, (4000, 4000)), PixelRect { x: 20, y: 41, width: 201, height: 101 });
        assert_eq!(device_rect(rect(-5.0, -5.0, 20.0, 20.0), 2.0, 2.0, (4000, 4000)), PixelRect { x: 0, y: 0, width: 30, height: 30 });
        assert_eq!(device_rect(rect(90.0, 40.0, 50.0, 50.0), 1.0, 1.0, (100, 50)), PixelRect { x: 90, y: 40, width: 10, height: 10 });
        assert_eq!(device_rect(rect(200.0, 0.0, 10.0, 10.0), 1.0, 1.0, (100, 50)).width, 0);
    }

    #[test]
    fn fit_within_caps_the_long_edge() {
        assert_eq!(fit_within(1000, 400, MAX_EDGE), (1000, 400));
        assert_eq!(fit_within(3000, 1000, MAX_EDGE), (1568, 523));
        assert_eq!(fit_within(1000, 5000, MAX_EDGE), (314, 1568));
        assert_eq!(fit_within(10000, 1, MAX_EDGE), (1568, 1));
    }

    #[test]
    fn a_box_on_a_retina_display() {
        // A 100×50 CSS-pixel overlay captured at 2×: left half red, right half blue.
        let shot = RgbaImage::from_fn(200, 100, |x, _| if x < 100 { RED } else { BLUE });
        let req = CropRequest { rect: rect(25.0, 0.0, 50.0, 50.0), path: None, viewport: CssSize { width: 100.0, height: 50.0 } };
        let out = crop(&shot, &req).unwrap();
        assert_eq!(out.dimensions(), (100, 100));
        assert_eq!(out.get_pixel(10, 50).0, [220, 20, 20]);
        assert_eq!(out.get_pixel(90, 50).0, [20, 20, 220]);
    }

    #[test]
    fn a_large_crop_is_downscaled() {
        let shot = RgbaImage::from_pixel(4000, 1000, RED);
        let req = CropRequest { rect: rect(0.0, 0.0, 2000.0, 500.0), path: None, viewport: CssSize { width: 2000.0, height: 500.0 } };
        let out = crop(&shot, &req).unwrap();
        assert_eq!(out.dimensions(), (1568, 392));
        assert_eq!(out.get_pixel(784, 196).0, [220, 20, 20]);
    }

    #[test]
    fn an_outline_with_more_points_than_anyone_draws_is_refused() {
        let shot = RgbaImage::from_pixel(100, 100, RED);
        let path = vec![CssPoint { x: 1.0, y: 1.0 }; MAX_PATH_POINTS + 1];
        let req = CropRequest { rect: rect(0.0, 0.0, 50.0, 50.0), path: Some(path), viewport: CssSize { width: 100.0, height: 100.0 } };
        assert_eq!(crop(&shot, &req), Err(CropError::TooDetailed));
    }

    #[test]
    fn an_empty_selection_is_an_error() {
        let shot = RgbaImage::from_pixel(100, 100, RED);
        let req = CropRequest { rect: rect(150.0, 0.0, 10.0, 10.0), path: None, viewport: CssSize { width: 100.0, height: 100.0 } };
        assert_eq!(crop(&shot, &req), Err(CropError::Empty));
    }

    #[test]
    fn freeform_keeps_the_inside_and_paints_the_outside_white() {
        // All red at 2×; a diamond drawn inside a 100×100 CSS box.
        let shot = RgbaImage::from_pixel(400, 400, RED);
        let path = vec![pt(100.0, 50.0), pt(150.0, 100.0), pt(100.0, 150.0), pt(50.0, 100.0)];
        let req = CropRequest { rect: rect(50.0, 50.0, 100.0, 100.0), path: Some(path), viewport: CssSize { width: 200.0, height: 200.0 } };
        let out = crop(&shot, &req).unwrap();
        assert_eq!(out.dimensions(), (200, 200));
        assert_eq!(out.get_pixel(100, 100).0, [220, 20, 20], "centre is inside");
        for (x, y) in [(2, 2), (197, 2), (2, 197), (197, 197)] {
            assert_eq!(out.get_pixel(x, y).0, [255, 255, 255], "corner ({x}, {y}) is outside");
        }
        // Just inside and just outside the left vertex.
        assert_eq!(out.get_pixel(4, 100).0, [220, 20, 20]);
        assert_eq!(out.get_pixel(60, 10).0, [255, 255, 255]);
    }

    #[test]
    fn freeform_outline_follows_a_downscale() {
        // A 3200×800 device-pixel crop is downscaled to 1568×392; the triangle must shrink with it.
        let shot = RgbaImage::from_pixel(3200, 800, RED);
        let path = vec![pt(0.0, 0.0), pt(1600.0, 0.0), pt(0.0, 400.0)];
        let req = CropRequest { rect: rect(0.0, 0.0, 1600.0, 400.0), path: Some(path), viewport: CssSize { width: 1600.0, height: 400.0 } };
        let out = crop(&shot, &req).unwrap();
        assert_eq!(out.dimensions(), (1568, 392));
        assert_eq!(out.get_pixel(10, 10).0, [220, 20, 20]);
        assert_eq!(out.get_pixel(1500, 380).0, [255, 255, 255]);
    }

    #[test]
    fn winding_is_non_zero_like_the_canvas() {
        // Two overlapping squares drawn as one path in the same direction: the
        // overlap stays filled under non-zero (even-odd would hollow it out).
        let mut img = RgbImage::from_pixel(30, 10, image::Rgb([0, 0, 0]));
        let path = [(0.0, 0.0), (20.0, 0.0), (20.0, 10.0), (0.0, 10.0), (0.0, 0.0), (10.0, 0.0), (30.0, 0.0), (30.0, 10.0), (10.0, 10.0), (10.0, 0.0)];
        paint_outside(&mut img, &path);
        assert_eq!(img.get_pixel(15, 5).0, [0, 0, 0]);
        assert_eq!(img.get_pixel(5, 5).0, [0, 0, 0]);
        assert_eq!(img.get_pixel(25, 5).0, [0, 0, 0]);
    }

    #[test]
    fn data_url_is_a_png_of_the_crop() {
        let img = RgbImage::from_pixel(7, 3, image::Rgb([1, 2, 3]));
        let url = png_data_url(&img);
        let b64 = url.strip_prefix("data:image/png;base64,").unwrap();
        let bytes = base64::engine::general_purpose::STANDARD.decode(b64).unwrap();
        let back = image::load_from_memory_with_format(&bytes, image::ImageFormat::Png).unwrap();
        assert_eq!((back.width(), back.height()), (7, 3));
    }
}
