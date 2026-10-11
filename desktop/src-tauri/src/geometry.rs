//! Where displays are, which one the pointer is on, and where the overlay and
//! the panel go on it.
//!
//! Tauri reports every display in "physical" pixels, but what that means
//! depends on the system:
//!
//! - **macOS** has one global space in points (logical pixels). Tauri scales
//!   each display's frame by *that display's* backing scale, but the pointer
//!   by the *main display's*, and moves windows using the scale of the
//!   display the window is on now. Mixing a Retina laptop with a standard
//!   monitor, physical numbers from different displays do not line up, so
//!   everything here is brought back to points first, and windows are placed
//!   in logical units.
//! - **Windows** (per-monitor DPI aware) and **X11** have one global space in
//!   physical pixels, which Tauri passes through as is.
//!
//! Pure, so the mixed-scale and negative-coordinate cases are unit-tested.

use serde::{Deserialize, Serialize};

/// Which coordinate space the system's display numbers live in.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Space {
    /// macOS: points; each display's physical frame is its points times its own scale.
    Points,
    /// Windows and X11: one physical space.
    Physical,
}

impl Space {
    pub const fn native() -> Self {
        if cfg!(target_os = "macos") {
            Space::Points
        } else {
            Space::Physical
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub const fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && y >= self.y && x < self.x + self.width && y < self.y + self.height
    }

    pub fn scaled(&self, by: f64) -> Rect {
        Rect::new(self.x * by, self.y * by, self.width * by, self.height * by)
    }

    /// Squared distance from a point to the nearest edge (0 inside).
    fn distance2(&self, x: f64, y: f64) -> f64 {
        let dx = (self.x - x).max(0.0).max(x - (self.x + self.width));
        let dy = (self.y - y).max(0.0).max(y - (self.y + self.height));
        dx * dx + dy * dy
    }
}

/// A display as Tauri reports it.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Display {
    pub name: String,
    /// Frame, in Tauri's physical pixels.
    pub frame: Rect,
    /// The part not taken by the menu bar, Dock or taskbar, in Tauri's physical pixels.
    pub work: Rect,
    pub scale: f64,
}

/// Where a window goes: in logical units (macOS), or physical (Windows, X11).
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Placement {
    Logical(Rect),
    Physical(Rect),
}

impl Display {
    /// The frame in the system's global space: points on macOS, physical pixels elsewhere.
    pub fn global_frame(&self, space: Space) -> Rect {
        match space {
            Space::Points => self.frame.scaled(1.0 / self.scale),
            Space::Physical => self.frame,
        }
    }

    fn global_work(&self, space: Space) -> Rect {
        match space {
            Space::Points => self.work.scaled(1.0 / self.scale),
            Space::Physical => self.work,
        }
    }

    /// The overlay covers the whole display, menu bar and Dock included.
    pub fn overlay_placement(&self, space: Space) -> Placement {
        match space {
            Space::Points => Placement::Logical(self.global_frame(space)),
            Space::Physical => Placement::Physical(self.frame),
        }
    }

    /// The panel: docked to the right edge of the usable area, full height,
    /// `width` CSS pixels wide (narrower on a small screen).
    pub fn panel_placement(&self, space: Space, width: f64) -> Placement {
        match space {
            Space::Points => {
                let work = self.global_work(space);
                let w = width.min(work.width);
                Placement::Logical(Rect::new(work.x + work.width - w, work.y, w, work.height))
            }
            Space::Physical => {
                let w = (width * self.scale).min(self.work.width).round();
                Placement::Physical(Rect::new(self.work.x + self.work.width - w, self.work.y, w, self.work.height))
            }
        }
    }
}

impl Placement {
    /// The same frame for a window with a title bar and borders: Tauri sizes
    /// a window's content but positions its frame, so the frame's extra
    /// (`frame`, logical pixels: title bar and borders together) comes off
    /// the size, or the bottom of the window ends under the Dock or taskbar.
    pub fn content(self, frame: (f64, f64), scale: f64) -> Placement {
        let fit = |r: Rect, k: f64| Rect::new(r.x, r.y, (r.width - frame.0 * k).max(1.0), (r.height - frame.1 * k).max(1.0));
        match self {
            Placement::Logical(r) => Placement::Logical(fit(r, 1.0)),
            Placement::Physical(r) => Placement::Physical(fit(r, scale)),
        }
    }
}

/// The pointer in the system's global space. `cursor` is what Tauri reports,
/// which on macOS is points times the *main* display's scale.
pub fn global_cursor(cursor: (f64, f64), space: Space, main_scale: f64) -> (f64, f64) {
    match space {
        Space::Points => (cursor.0 / main_scale, cursor.1 / main_scale),
        Space::Physical => cursor,
    }
}

/// The display the pointer is on, or the nearest one (the pointer can sit on
/// the very edge, or between displays of different heights). None only when
/// there are no displays at all.
pub fn display_at(displays: &[Display], cursor: (f64, f64), space: Space) -> Option<usize> {
    let (x, y) = cursor;
    if let Some(i) = displays.iter().position(|d| d.global_frame(space).contains(x, y)) {
        return Some(i);
    }
    displays
        .iter()
        .enumerate()
        .min_by(|(_, a), (_, b)| a.global_frame(space).distance2(x, y).total_cmp(&b.global_frame(space).distance2(x, y)))
        .map(|(i, _)| i)
}

/// The pointer in a display's overlay, in CSS pixels from its top-left corner.
pub fn to_overlay_css(display: &Display, cursor: (f64, f64), space: Space) -> (f64, f64) {
    let frame = display.global_frame(space);
    match space {
        Space::Points => (cursor.0 - frame.x, cursor.1 - frame.y),
        Space::Physical => ((cursor.0 - frame.x) / display.scale, (cursor.1 - frame.y) / display.scale),
    }
}

/// Whether a point (CSS pixels in the overlay) is on any of its interactive
/// parts, with a little slack so the edge of the bar is not a dead zone.
pub fn over_regions(regions: &[Rect], point: (f64, f64), slack: f64) -> bool {
    regions
        .iter()
        .any(|r| Rect::new(r.x - slack, r.y - slack, r.width + 2.0 * slack, r.height + 2.0 * slack).contains(point.0, point.1))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display(name: &str, frame: Rect, work: Rect, scale: f64) -> Display {
        Display { name: name.into(), frame, work, scale }
    }

    /// A Retina laptop (1512×982 pt at 2×) with a standard 1920×1080 monitor
    /// to its right and another to its left, the way Tauri reports them on macOS.
    fn mac_desk() -> Vec<Display> {
        vec![
            display("Built-in", Rect::new(0.0, 0.0, 3024.0, 1964.0), Rect::new(0.0, 74.0, 3024.0, 1890.0), 2.0),
            display("Right", Rect::new(1512.0, 0.0, 1920.0, 1080.0), Rect::new(1512.0, 25.0, 1920.0, 1055.0), 1.0),
            display("Left", Rect::new(-1920.0, -98.0, 1920.0, 1080.0), Rect::new(-1920.0, -73.0, 1920.0, 1055.0), 1.0),
        ]
    }

    #[test]
    fn mac_frames_come_back_to_points() {
        let desk = mac_desk();
        assert_eq!(desk[0].global_frame(Space::Points), Rect::new(0.0, 0.0, 1512.0, 982.0));
        assert_eq!(desk[1].global_frame(Space::Points), Rect::new(1512.0, 0.0, 1920.0, 1080.0));
        assert_eq!(desk[2].global_frame(Space::Points), Rect::new(-1920.0, -98.0, 1920.0, 1080.0));
    }

    #[test]
    fn mac_pointer_on_the_standard_monitor() {
        // At (2000, 500) pt, which Tauri reports times the main display's 2×.
        let desk = mac_desk();
        let cursor = global_cursor((4000.0, 1000.0), Space::Points, 2.0);
        assert_eq!(cursor, (2000.0, 500.0));
        assert_eq!(display_at(&desk, cursor, Space::Points), Some(1));
        assert_eq!(to_overlay_css(&desk[1], cursor, Space::Points), (488.0, 500.0));
    }

    #[test]
    fn mac_pointer_left_of_the_main_display() {
        let desk = mac_desk();
        let cursor = global_cursor((-200.0, -100.0), Space::Points, 2.0);
        assert_eq!(cursor, (-100.0, -50.0));
        assert_eq!(display_at(&desk, cursor, Space::Points), Some(2));
        assert_eq!(to_overlay_css(&desk[2], cursor, Space::Points), (1820.0, 48.0));
    }

    #[test]
    fn mac_pointer_on_the_retina_display() {
        let desk = mac_desk();
        let cursor = global_cursor((3000.0, 1900.0), Space::Points, 2.0);
        assert_eq!(display_at(&desk, cursor, Space::Points), Some(0));
        assert_eq!(to_overlay_css(&desk[0], cursor, Space::Points), (1500.0, 950.0));
    }

    #[test]
    fn mac_windows_are_placed_in_points() {
        let desk = mac_desk();
        assert_eq!(desk[0].overlay_placement(Space::Points), Placement::Logical(Rect::new(0.0, 0.0, 1512.0, 982.0)));
        // Docked right, under the menu bar (37 pt on a notched laptop), full height.
        assert_eq!(desk[0].panel_placement(Space::Points, 420.0), Placement::Logical(Rect::new(1092.0, 37.0, 420.0, 945.0)));
        assert_eq!(desk[2].panel_placement(Space::Points, 420.0), Placement::Logical(Rect::new(-420.0, -73.0, 420.0, 1055.0)));
    }

    /// Windows, per-monitor DPI aware: a 4K monitor at 150% and a 1080p one at 100% to its right.
    fn windows_desk() -> Vec<Display> {
        vec![
            display("4K", Rect::new(0.0, 0.0, 3840.0, 2160.0), Rect::new(0.0, 0.0, 3840.0, 2088.0), 1.5),
            display("1080p", Rect::new(3840.0, 200.0, 1920.0, 1080.0), Rect::new(3840.0, 200.0, 1920.0, 1040.0), 1.0),
            display("Left", Rect::new(-2560.0, 0.0, 2560.0, 1440.0), Rect::new(-2560.0, 0.0, 2560.0, 1400.0), 1.25),
        ]
    }

    #[test]
    fn windows_pointer_stays_physical() {
        let desk = windows_desk();
        let cursor = global_cursor((4000.0, 300.0), Space::Physical, 1.5);
        assert_eq!(display_at(&desk, cursor, Space::Physical), Some(1));
        assert_eq!(to_overlay_css(&desk[1], cursor, Space::Physical), (160.0, 100.0));
        // On the 150% monitor, CSS pixels are physical / 1.5.
        assert_eq!(to_overlay_css(&desk[0], (1500.0, 300.0), Space::Physical), (1000.0, 200.0));
        // Negative coordinates, 125%.
        assert_eq!(display_at(&desk, (-100.0, 50.0), Space::Physical), Some(2));
        assert_eq!(to_overlay_css(&desk[2], (-100.0, 50.0), Space::Physical), (1968.0, 40.0));
    }

    #[test]
    fn windows_panel_width_scales_with_the_monitor() {
        let desk = windows_desk();
        assert_eq!(desk[0].panel_placement(Space::Physical, 420.0), Placement::Physical(Rect::new(3210.0, 0.0, 630.0, 2088.0)));
        assert_eq!(desk[0].overlay_placement(Space::Physical), Placement::Physical(Rect::new(0.0, 0.0, 3840.0, 2160.0)));
    }

    #[test]
    fn pointer_between_displays_goes_to_the_nearest() {
        let desk = windows_desk();
        // Below the 1080p monitor, which starts lower and ends higher than the 4K one.
        assert_eq!(display_at(&desk, (4500.0, 1400.0), Space::Physical), Some(1));
        assert_eq!(display_at(&[], (0.0, 0.0), Space::Physical), None);
    }

    #[test]
    fn the_panel_frame_fits_the_work_area() {
        // macOS: a 28 pt title bar comes off the height, in points.
        let mac = mac_desk();
        assert_eq!(
            mac[0].panel_placement(Space::Points, 420.0).content((0.0, 28.0), 2.0),
            Placement::Logical(Rect::new(1092.0, 37.0, 420.0, 917.0))
        );
        // Windows at 150%: 31 + 8 px of frame (logical) is 58.5 physical.
        let win = windows_desk();
        assert_eq!(
            win[0].panel_placement(Space::Physical, 420.0).content((16.0, 39.0), 1.5),
            Placement::Physical(Rect::new(3210.0, 0.0, 606.0, 2029.5))
        );
    }

    #[test]
    fn panel_never_wider_than_the_screen() {
        let small = display("Small", Rect::new(0.0, 0.0, 800.0, 600.0), Rect::new(0.0, 0.0, 300.0, 600.0), 1.0);
        assert_eq!(small.panel_placement(Space::Physical, 420.0), Placement::Physical(Rect::new(0.0, 0.0, 300.0, 600.0)));
    }

    #[test]
    fn regions_have_a_little_slack() {
        let bar = [Rect::new(100.0, 900.0, 500.0, 44.0)];
        assert!(over_regions(&bar, (100.0, 900.0), 2.0));
        assert!(over_regions(&bar, (98.5, 945.5), 2.0));
        assert!(!over_regions(&bar, (97.0, 900.0), 2.0));
        assert!(!over_regions(&[], (0.0, 0.0), 2.0));
    }
}
