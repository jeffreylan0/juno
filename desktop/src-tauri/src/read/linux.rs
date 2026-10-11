//! Linux, for development and the end-to-end tests only: the `tesseract`
//! command (tesseract-ocr), run on the screenshot. Without it, nothing is
//! read and the overlay says so.

use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};

use image::RgbaImage;

use super::{union, Line, Word};
use crate::geometry::Rect;

static RUN: AtomicU32 = AtomicU32::new(0);

pub fn recognize(image: &RgbaImage) -> Result<Vec<Line>, String> {
    let path = std::env::temp_dir().join(format!("sai-read-{}-{}.png", std::process::id(), RUN.fetch_add(1, Ordering::Relaxed)));
    image.save(&path).map_err(|e| format!("Could not keep the screenshot to read: {e}"))?;
    let out = Command::new("tesseract").arg(&path).arg("stdout").args(["--psm", "3", "tsv"]).output();
    let _ = std::fs::remove_file(&path);
    let out = out.map_err(|e| format!("Text recognition needs tesseract on Linux: {e}"))?;
    if !out.status.success() {
        return Err(format!("tesseract failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
    }
    Ok(parse_tsv(&String::from_utf8_lossy(&out.stdout)))
}

/// tesseract's TSV: one row per word (level 5), numbered by block, paragraph
/// and line; confidence 0 to 100.
pub fn parse_tsv(tsv: &str) -> Vec<Line> {
    let mut lines: Vec<((u32, u32, u32), Vec<(Word, f32)>)> = Vec::new();
    for row in tsv.lines().skip(1) {
        let cols: Vec<&str> = row.split('\t').collect();
        if cols.len() < 12 || cols[0] != "5" {
            continue;
        }
        let num = |i: usize| cols[i].trim().parse::<f64>().unwrap_or(0.0);
        let text = cols[11].trim();
        if text.is_empty() {
            continue;
        }
        let key = (num(2) as u32, num(3) as u32, num(4) as u32);
        let word = Word { text: text.to_string(), rect: Rect::new(num(6), num(7), num(8), num(9)) };
        let conf = (num(10) as f32 / 100.0).clamp(0.0, 1.0);
        match lines.last_mut() {
            Some((k, words)) if *k == key => words.push((word, conf)),
            _ => lines.push((key, vec![(word, conf)])),
        }
    }
    lines
        .into_iter()
        .filter_map(|(_, words)| {
            let rect = union(words.iter().map(|(w, _)| w.rect))?;
            let confidence = words.iter().map(|(_, c)| *c).fold(1.0f32, f32::min);
            let words: Vec<Word> = words.into_iter().map(|(w, _)| w).collect();
            Some(Line { text: words.iter().map(|w| w.text.as_str()).collect::<Vec<_>>().join(" "), rect, words, confidence })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn groups_words_into_lines() {
        let tsv = "level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n\
                   1\t1\t0\t0\t0\t0\t0\t0\t800\t600\t-1\t\n\
                   4\t1\t1\t1\t1\t0\t10\t20\t200\t30\t-1\t\n\
                   5\t1\t1\t1\t1\t1\t10\t20\t90\t30\t96.5\tFind\n\
                   5\t1\t1\t1\t1\t2\t110\t22\t100\t28\t91\tdy/dx\n\
                   5\t1\t1\t1\t2\t1\t10\t60\t60\t30\t40\tnext\n\
                   5\t1\t1\t1\t2\t2\t80\t60\t40\t30\t-1\t \n";
        let lines = parse_tsv(tsv);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].text, "Find dy/dx");
        assert_eq!(lines[0].rect, Rect::new(10.0, 20.0, 200.0, 30.0));
        assert!((lines[0].confidence - 0.91).abs() < 1e-6);
        assert_eq!(lines[1].words.len(), 1);
        assert!((lines[1].confidence - 0.4).abs() < 1e-6);
    }
}
