//! What is on a display, read on this computer: its text, word by word with
//! where each word is (for Text and Element), and its windows (for Element).
//!
//! Nothing read here leaves the computer. The overlay uses it to show what
//! can be selected; only the selection goes on to the chat. No permission
//! beyond the Screen Recording a screenshot already needs: no accessibility
//! access, which would let the app read and control every other app.
//!
//! - macOS: Vision's text recognition (VNRecognizeTextRequest), on device.
//! - Windows: Windows.Media.Ocr, on device, in the user's languages.
//! - Linux (development and tests only): the `tesseract` command.

use image::RgbaImage;
use serde::Serialize;

use crate::geometry::{Rect, Space};

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(target_os = "linux")]
use linux as platform;
#[cfg(target_os = "macos")]
use macos as platform;
#[cfg(windows)]
use windows as platform;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Word {
    pub text: String,
    pub rect: Rect,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Line {
    pub text: String,
    pub rect: Rect,
    pub words: Vec<Word>,
    /// 0 to 1; 1 where the system gives no confidence (Windows).
    pub confidence: f32,
}

/// A window of another app, as the system lists it.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct WindowFrame {
    pub app: String,
    pub title: String,
    pub rect: Rect,
}

/// The text in a screenshot, in its pixels, line by line.
pub fn recognize(image: &RgbaImage) -> Result<Vec<Line>, String> {
    platform::recognize(image)
}

/// The other apps' windows on screen, front to back, in the system's global space.
pub fn windows() -> Vec<WindowFrame> {
    crate::capture::window_list().into_iter().map(|(source, rect)| WindowFrame { app: source.app, title: source.title, rect }).collect()
}

/// Lines and words from a screenshot's pixels to the overlay's CSS pixels.
pub fn to_css(lines: Vec<Line>, sx: f64, sy: f64) -> Vec<Line> {
    let scale = |r: Rect| Rect::new(r.x * sx, r.y * sy, r.width * sx, r.height * sy);
    lines
        .into_iter()
        .map(|l| Line {
            rect: scale(l.rect),
            words: l.words.into_iter().map(|w| Word { rect: scale(w.rect), ..w }).collect(),
            ..l
        })
        .collect()
}

/// The windows on the display at `frame` (global space), in that display's
/// CSS pixels, cut to it; slivers and windows off it are left out.
pub fn windows_on(windows: Vec<WindowFrame>, frame: Rect, space: Space, scale: f64) -> Vec<WindowFrame> {
    let per_css = match space {
        Space::Points => 1.0,
        Space::Physical => scale,
    };
    windows
        .into_iter()
        .filter_map(|w| {
            let left = w.rect.x.max(frame.x);
            let top = w.rect.y.max(frame.y);
            let right = (w.rect.x + w.rect.width).min(frame.x + frame.width);
            let bottom = (w.rect.y + w.rect.height).min(frame.y + frame.height);
            let rect = Rect::new((left - frame.x) / per_css, (top - frame.y) / per_css, (right - left) / per_css, (bottom - top) / per_css);
            (rect.width >= 48.0 && rect.height >= 48.0).then_some(WindowFrame { rect, ..w })
        })
        .collect()
}

/// A line's words when the system gives only the line's box: the box split
/// by characters, which is close enough for proportional text.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // macOS falls back to it
pub fn split_words(text: &str, rect: Rect) -> Vec<Word> {
    let total = text.chars().count().max(1) as f64;
    let mut words = Vec::new();
    let mut at = 0usize;
    for part in text.split(' ') {
        let n = part.chars().count();
        if !part.is_empty() {
            let x = rect.x + rect.width * at as f64 / total;
            words.push(Word { text: part.to_string(), rect: Rect::new(x, rect.y, rect.width * n as f64 / total, rect.height) });
        }
        at += n + 1;
    }
    words
}

/// The smallest box around some boxes.
pub fn union(rects: impl IntoIterator<Item = Rect>) -> Option<Rect> {
    rects.into_iter().reduce(|a, b| {
        let left = a.x.min(b.x);
        let top = a.y.min(b.y);
        let right = (a.x + a.width).max(b.x + b.width);
        let bottom = (a.y + a.height).max(b.y + b.height);
        Rect::new(left, top, right - left, bottom - top)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scales_lines_and_words_to_css_pixels() {
        let lines = vec![Line {
            text: "x = 2".into(),
            rect: Rect::new(200.0, 100.0, 100.0, 40.0),
            words: vec![Word { text: "x".into(), rect: Rect::new(200.0, 100.0, 20.0, 40.0) }],
            confidence: 0.9,
        }];
        let css = to_css(lines, 0.5, 0.5);
        assert_eq!(css[0].rect, Rect::new(100.0, 50.0, 50.0, 20.0));
        assert_eq!(css[0].words[0].rect, Rect::new(100.0, 50.0, 10.0, 20.0));
        assert_eq!(css[0].text, "x = 2");
    }

    #[test]
    fn keeps_the_windows_on_a_display_cut_to_it() {
        let w = |x, y, wd, h| WindowFrame { app: "Preview".into(), title: "a.pdf".into(), rect: Rect::new(x, y, wd, h) };
        // A display left of the main one, in points (macOS).
        let frame = Rect::new(-1440.0, 0.0, 1440.0, 900.0);
        let out = windows_on(vec![w(-1500.0, 100.0, 700.0, 500.0), w(100.0, 100.0, 500.0, 500.0), w(-200.0, 880.0, 400.0, 400.0)], frame, Space::Points, 2.0);
        assert_eq!(out.len(), 1, "the window on the main display and the sliver at the bottom are left out");
        assert_eq!(out[0].rect, Rect::new(0.0, 100.0, 640.0, 500.0));
        // Windows: physical pixels, CSS pixels are those over the scale.
        let out = windows_on(vec![w(1920.0, 200.0, 960.0, 600.0)], Rect::new(1920.0, 0.0, 3840.0, 2160.0), Space::Physical, 1.5);
        assert_eq!(out[0].rect, Rect::new(0.0, 200.0 / 1.5, 640.0, 400.0));
    }

    #[test]
    fn splits_a_line_box_by_characters() {
        let words = split_words("ab cd", Rect::new(0.0, 0.0, 50.0, 10.0));
        assert_eq!(words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>(), ["ab", "cd"]);
        assert_eq!(words[0].rect, Rect::new(0.0, 0.0, 20.0, 10.0));
        assert_eq!(words[1].rect, Rect::new(30.0, 0.0, 20.0, 10.0));
    }
}
